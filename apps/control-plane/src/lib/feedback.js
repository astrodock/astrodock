'use strict';

// Feedback from an app's users, and the work it turns into.
//
// THE ONE RULE THIS MODULE ENFORCES: what an operator or an agent writes about
// a problem, and what the person who reported it reads, are different things,
// and mixing them up is the failure that matters. A user gets an
// acknowledgement, a fix, and instructions that mean something to them. They do
// not get a stack trace, a root cause, or an agent's reasoning.
//
// That is not implemented as a flag on a message, because a flag is something
// you remember. There is no visibility parameter in this module's API at all:
//
//   note()  is always internal
//   reply() is always visible to the submitter
//
// Two functions, each hard-coding its own value. A caller cannot pass the wrong
// one because there is nothing to pass. Everything that reads a thread for a
// user goes through userVisible(), which filters on the column AND on `pending`,
// so an AI draft nobody has approved is not a message either.
//
// See FEEDBACK_DESIGN.md.

const { and, eq, sql } = require('drizzle-orm');
const { db, schema } = require('../db');

// Carried over from the CCM project, which has run them against real users.
// `answered` closes a question; `shipped` closes something that became work.
// Both are terminal, and which one it was is a question worth being able to ask.
const STATUSES = ['new', 'under_review', 'planned', 'in_progress', 'shipped', 'answered', 'declined'];
const TERMINAL = ['shipped', 'answered', 'declined'];
const WORK_STATUSES = ['open', 'in_progress', 'done', 'wont_do'];
const WORK_TYPES = ['bug', 'feature', 'chore'];
const RELATION_KINDS = ['relates_to', 'blocks', 'parent', 'duplicate_of', 'supersedes'];
const DEFAULT_CATEGORIES = ['bug', 'idea', 'question'];

// ── pure helpers ─────────────────────────────────────────────────────────────

const LIMITS = { title: 200, body: 10000, category: 40, email: 320, contextValue: 2000 };

/** The app's feedback settings, with the platform's opinion as the default. */
function configFor(app) {
  const c = (app && app.feedbackConfig) || {};
  return {
    enabled: c.enabled !== false,
    widget: c.widget !== false,
    anonymous: c.anonymous === true,
    snapshot: c.snapshot === true,
    categories: Array.isArray(c.categories) && c.categories.length ? c.categories : DEFAULT_CATEGORIES,
    // off | draft | auto. Draft by default: a bad auto-reply reaches a real
    // person and cannot be recalled.
    aiMode: ['off', 'draft', 'auto'].includes(c.ai_mode) ? c.ai_mode : 'draft',
    webhook: typeof c.webhook === 'string' ? c.webhook : ''
  };
}

/**
 * Whatever the widget collected about the page, reduced to a known shape.
 *
 * Submissions arrive from a browser, so this is attacker-controlled: an
 * unbounded jsonb column would take a megabyte of anything. Only these keys
 * survive, each truncated, and everything else is dropped rather than kept
 * "just in case".
 */
function sanitizeContext(raw) {
  const allowed = ['url', 'referrer', 'viewport', 'userAgent', 'appVersion', 'deployId', 'locale', 'path'];
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of allowed) {
    const v = raw[k];
    if (v == null || v === '') continue;
    out[k] = String(v).slice(0, LIMITS.contextValue);
  }
  return out;
}

/**
 * Validate and normalize a submission. Returns { ok, value } or { ok:false, error }.
 * `config` comes from configFor(app).
 */
function validateSubmission(input = {}, config = configFor(null)) {
  const title = String(input.title || '').trim().slice(0, LIMITS.title);
  const body = String(input.body || '').trim().slice(0, LIMITS.body);
  if (!title && !body) return { ok: false, error: 'Say something about the problem.' };

  let category = String(input.category || '').trim().slice(0, LIMITS.category);
  // An unknown category is not worth refusing a person's bug report over.
  if (!config.categories.includes(category)) category = 'other';

  const email = String(input.email || '').trim().toLowerCase().slice(0, LIMITS.email);

  return {
    ok: true,
    value: {
      // A title is what a list is readable by, so derive one rather than
      // showing thirty rows of "(no title)".
      title: title || body.split('\n')[0].slice(0, 80),
      body,
      category,
      submitterEmail: email,
      context: sanitizeContext(input.context)
    }
  };
}

/**
 * The view of a feedback item its submitter is allowed to see.
 *
 * Deliberately a whitelist. A new internal column added later is invisible here
 * until someone decides otherwise, which is the right way round.
 */
function redactForUser(item, messages = []) {
  if (!item) return null;
  return {
    key: item.key,
    title: item.title,
    body: item.body,
    category: item.category,
    status: item.status,
    createdAt: item.createdAt,
    answeredAt: item.answeredAt || null,
    messages: userVisibleOf(messages).map((m) => ({
      body: m.body,
      fromSupport: m.authorKind !== 'user',
      createdAt: m.createdAt
    }))
  };
}

/**
 * Filter a list of messages down to what the submitter may read.
 *
 * Both conditions matter. `visibility` keeps internal notes out; `pending`
 * keeps out an AI draft that no human has approved, which is a message written
 * for the user but not yet meant for them.
 */
function userVisibleOf(messages = []) {
  return messages.filter((m) => m && m.visibility === 'user' && !m.pending);
}

/**
 * Origins allowed to post feedback for an app.
 *
 * Not `*`. The intake is reachable without an operator credential, so the
 * browsers allowed to talk to it are the ones on the app's own pages: its
 * platform subdomain, plus any custom domain that has finished verification. A
 * pending domain is one somebody has merely claimed.
 */
function originsFor(app, domains = [], baseDomain = '') {
  const out = [];
  if (app && app.subdomain && baseDomain) out.push(`https://${app.subdomain}.${baseDomain}`);
  for (const d of domains) {
    if (d && d.status === 'active' && d.hostname) out.push(`https://${d.hostname}`);
  }
  return out;
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * The next F-n / I-n for an app.
 *
 * An upsert that increments and returns in one statement, so two submissions in
 * the same moment get different numbers. MAX(key)+1 would hand both the same one
 * and let the unique index decide who loses.
 *
 * A number is claimed before the row is inserted, so a failed insert leaves a
 * gap. Gaps are fine; two people holding F-12 is not.
 */
async function nextKey(appId, kind, tx = db) {
  const prefix = kind === 'work' ? 'I' : 'F';
  const [row] = await tx.execute(sql`
    INSERT INTO app_counters (app_id, kind, n) VALUES (${appId}, ${kind}, 1)
    ON CONFLICT (app_id, kind) DO UPDATE SET n = app_counters.n + 1
    RETURNING n
  `);
  return `${prefix}-${row.n}`;
}

// ── feedback ─────────────────────────────────────────────────────────────────

/**
 * Record a submission.
 *
 * `identity` is a person the APP has vouched for, verified against the app's own
 * signing secret before it gets here. An email the submitter typed into the form
 * is not identity: anyone can type an address, so it is contact information and
 * nothing more. That distinction is what the anonymous gate turns on.
 */
async function submit({ app, identity = null, ...input }) {
  const config = configFor(app);
  if (!config.enabled) throw new Error('This app is not accepting feedback.');
  if (!identity && !config.anonymous) throw new Error('Sign in to send feedback.');

  const checked = validateSubmission(input, config);
  if (!checked.ok) throw new Error(checked.error);

  const key = await nextKey(app.id, 'feedback');
  const [row] = await db.insert(schema.feedback).values({
    appId: app.id,
    key,
    submittedBy: (identity && identity.userId) || null,
    ...checked.value,
    // A verified address beats a typed one.
    submitterEmail: (identity && identity.email) || checked.value.submitterEmail
  }).returning();
  return row;
}

/** An internal note. Never reaches the submitter. */
async function note({ feedbackId, authorKind = 'operator', authorId = '', body }) {
  return addMessage(feedbackId, 'internal', { authorKind, authorId, body, pending: false });
}

/**
 * A message the submitter will read.
 *
 * `pending` is the AI-draft case: written into the user thread but held until a
 * human sends it, and invisible to the user until then.
 */
async function reply({ feedbackId, authorKind = 'operator', authorId = '', body, pending = false }) {
  return addMessage(feedbackId, 'user', { authorKind, authorId, body, pending: !!pending });
}

// The only writer of `visibility`, and both callers above pass a literal. Not
// exported: a third caller with a variable in that position is exactly what
// this design is trying to make impossible.
async function addMessage(feedbackId, visibility, { authorKind, authorId, body, pending }) {
  const text = String(body || '').trim().slice(0, LIMITS.body);
  if (!text) throw new Error('The message is empty.');
  const [row] = await db.insert(schema.feedbackMessages).values({
    feedbackId, visibility, authorKind, authorId: String(authorId || ''), body: text, pending
  }).returning();
  await touch(feedbackId);
  return row;
}

/** Send a held AI draft. The only way a pending message becomes visible. */
async function approveDraft(messageId) {
  const [row] = await db.update(schema.feedbackMessages)
    .set({ pending: false })
    .where(and(eq(schema.feedbackMessages.id, messageId), eq(schema.feedbackMessages.pending, true)))
    .returning();
  if (row) await touch(row.feedbackId);
  return row || null;
}

async function messages(feedbackId, { visibility } = {}) {
  const where = visibility
    ? and(eq(schema.feedbackMessages.feedbackId, feedbackId), eq(schema.feedbackMessages.visibility, visibility))
    : eq(schema.feedbackMessages.feedbackId, feedbackId);
  return db.select().from(schema.feedbackMessages).where(where)
    .orderBy(schema.feedbackMessages.createdAt);
}

/** What the submitter may read. The widget and the app-facing API use only this. */
async function userVisible(feedbackId) {
  return userVisibleOf(await messages(feedbackId, { visibility: 'user' }));
}

async function setStatus(feedbackId, status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  const patch = { status, updatedAt: new Date() };
  if (TERMINAL.includes(status)) patch.answeredAt = new Date();
  const [row] = await db.update(schema.feedback).set(patch)
    .where(eq(schema.feedback.id, feedbackId)).returning();
  return row || null;
}

async function touch(feedbackId) {
  await db.update(schema.feedback).set({ updatedAt: new Date() })
    .where(eq(schema.feedback.id, feedbackId));
}

// ── work items ───────────────────────────────────────────────────────────────

async function createWorkItem({ appId, title, context = '', body = '', type = 'bug',
  priority = 'P2', size = '', area = '' }) {
  if (!String(title || '').trim()) throw new Error('A work item needs a title.');
  if (!WORK_TYPES.includes(type)) throw new Error(`Unknown type: ${type}`);
  const key = await nextKey(appId, 'work');
  const [row] = await db.insert(schema.workItems).values({
    appId, key, title: String(title).trim(), context, body, type, priority, size, area
  }).returning();
  return row;
}

async function setWorkStatus(itemId, status) {
  if (!WORK_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  const patch = { status, updatedAt: new Date() };
  patch.doneAt = (status === 'done' || status === 'wont_do') ? new Date() : null;
  const [row] = await db.update(schema.workItems).set(patch)
    .where(eq(schema.workItems.id, itemId)).returning();
  return row || null;
}

/** Link feedback to a work item. Many to many: one bug, a dozen reporters. */
async function link(feedbackId, workItemId) {
  await db.insert(schema.feedbackWorkItems).values({ feedbackId, workItemId })
    .onConflictDoNothing();
  return true;
}

async function unlink(feedbackId, workItemId) {
  await db.delete(schema.feedbackWorkItems).where(and(
    eq(schema.feedbackWorkItems.feedbackId, feedbackId),
    eq(schema.feedbackWorkItems.workItemId, workItemId)
  ));
  return true;
}

async function relate(fromId, toId, kind) {
  if (!RELATION_KINDS.includes(kind)) throw new Error(`Unknown relation: ${kind}`);
  if (fromId === toId) throw new Error('An item cannot relate to itself.');
  await db.insert(schema.workItemRelations).values({ fromId, toId, kind }).onConflictDoNothing();
  return true;
}

module.exports = {
  STATUSES, TERMINAL, WORK_STATUSES, WORK_TYPES, RELATION_KINDS, DEFAULT_CATEGORIES, LIMITS,
  configFor, sanitizeContext, validateSubmission, redactForUser, userVisibleOf,
  originsFor,
  nextKey, submit, note, reply, approveDraft, messages, userVisible, setStatus,
  createWorkItem, setWorkStatus, link, unlink, relate
};
