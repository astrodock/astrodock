'use strict';

// Feedback and work items, for operators and for agents.
//
// The design decision this file carries: SENDING A MESSAGE TO A USER IS ITS OWN
// PERMISSION. `feedback:write` covers triage, internal notes, status and drafting
// a reply. `feedback:reply` covers the one action that reaches a person, and it
// sits in the sensitive group.
//
// A caller with feedback:write but not feedback:reply is not refused when it
// posts a reply. It gets a DRAFT: the message is written into the user thread
// with pending = true, invisible to the user, waiting for someone to send it.
// That is the whole of "the AI drafts by default" — not a mode flag consulted at
// runtime, but what the permission it holds actually allows it to do.

const express = require('express');
const { and, eq, desc, inArray, notInArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const fb = require('../lib/feedback');
const { requireScope, requirePermission, callerHasScope, tokenAllowsApp } = require('../middleware/auth');
const { emitEvent } = require('../lib/events');

const router = express.Router();
router.use(requireScope('feedback:read'));

function actorFromAuth(auth) {
  if (!auth) return { actorType: 'system', actor: 'system' };
  if (auth.type === 'token') return { actorType: 'token', actor: auth.name || 'key' };
  return { actorType: 'admin', actor: auth.email || 'admin' };
}

function authorOf(auth) {
  if (!auth) return { authorKind: 'operator', authorId: '' };
  if (auth.type === 'token') return { authorKind: 'agent', authorId: auth.name || 'key' };
  return { authorKind: 'operator', authorId: auth.email || '' };
}

// Every route is scoped to one app, and a key with an app scope may not step
// outside it. Resolved once here rather than in nine handlers.
router.param('slug', async (req, res, next, slug) => {
  try {
    const [app] = await db.select().from(schema.apps)
      .where(eq(schema.apps.slug, String(slug).toLowerCase())).limit(1);
    if (!app) return res.status(404).json({ error: 'Unknown app' });
    if (!tokenAllowsApp(req.auth, app.slug)) return res.status(403).json({ error: 'This key is not scoped to that app' });
    req.app_ = app;     // not req.app: Express owns that one
    next();
  } catch (err) { next(err); }
});

async function itemByKey(appId, key) {
  const [row] = await db.select().from(schema.feedback)
    .where(and(eq(schema.feedback.appId, appId), eq(schema.feedback.key, String(key).toUpperCase()))).limit(1);
  return row || null;
}

// ── feedback ─────────────────────────────────────────────────────────────────

router.get('/:slug', async (req, res) => {
  // `open` is everything not yet closed, filtered in the query rather than by
  // the caller. Fetching a page and filtering it client-side drops open items
  // off the end as soon as an app has more feedback than one page.
  const wanted = String(req.query.status || '');
  let where = eq(schema.feedback.appId, req.app_.id);
  if (wanted === 'open') {
    where = and(where, notInArray(schema.feedback.status, fb.TERMINAL));
  } else if (wanted) {
    where = and(where, eq(schema.feedback.status, wanted));
  }
  const rows = await db.select().from(schema.feedback).where(where)
    .orderBy(desc(schema.feedback.createdAt)).limit(Math.min(Number(req.query.limit) || 100, 500));

  // The linked work items, in one query rather than one per row.
  const links = rows.length
    ? await db.select().from(schema.feedbackWorkItems)
      .where(inArray(schema.feedbackWorkItems.feedbackId, rows.map((r) => r.id)))
    : [];
  const items = links.length
    ? await db.select().from(schema.workItems)
      .where(inArray(schema.workItems.id, [...new Set(links.map((l) => l.workItemId))]))
    : [];
  const keyOf = new Map(items.map((i) => [i.id, i.key]));

  res.json({
    feedback: rows.map((r) => ({
      ...r,
      work: links.filter((l) => l.feedbackId === r.id).map((l) => keyOf.get(l.workItemId)).filter(Boolean)
    }))
  });
});

// One item, BOTH threads. This is the operator's view and the only place the
// internal thread is served; it needs feedback:read, which no app-facing route
// can reach.
router.get('/:slug/:key', async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  const all = await fb.messages(item.id);
  res.json({
    feedback: item,
    internal: all.filter((m) => m.visibility === 'internal'),
    user: all.filter((m) => m.visibility === 'user')
  });
});

router.post('/:slug/:key/notes', requirePermission('feedback:write'), async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  try {
    const row = await fb.note({ feedbackId: item.id, ...authorOf(req.auth), body: req.body.body });
    res.status(201).json({ message: row });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/**
 * A message for the person who reported it.
 *
 * Held as a draft unless the caller holds feedback:reply. Also held whenever the
 * caller asks for a draft, so a human can write one too.
 */
router.post('/:slug/:key/reply', requirePermission('feedback:write'), async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  const maySend = callerHasScope(req.auth, 'feedback:reply');
  const pending = !maySend || req.body.draft === true;
  try {
    const row = await fb.reply({ feedbackId: item.id, ...authorOf(req.auth), body: req.body.body, pending });
    if (!pending) {
      emitEvent({
        category: 'audit', type: 'feedback.replied', severity: 'info', ...actorFromAuth(req.auth),
        ip: req.ip, appSlug: req.app_.slug, targetType: 'feedback', targetId: item.key,
        message: `Replied to ${item.key}`
      }).catch(() => {});
    }
    res.status(201).json({ message: row, sent: !pending });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Send a held draft. The only transition that makes a pending message visible,
// and it needs the permission that a draft exists precisely because the author
// lacked.
router.post('/:slug/:key/messages/:id/send', requirePermission('feedback:reply'), async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  const row = await fb.approveDraft(req.params.id);
  if (!row || row.feedbackId !== item.id) return res.status(404).json({ error: 'No such draft' });
  emitEvent({
    category: 'audit', type: 'feedback.replied', severity: 'info', ...actorFromAuth(req.auth),
    ip: req.ip, appSlug: req.app_.slug, targetType: 'feedback', targetId: item.key,
    message: `Sent a drafted reply to ${item.key}`
  }).catch(() => {});
  res.json({ message: row, sent: true });
});

router.post('/:slug/:key/status', requirePermission('feedback:write'), async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  try {
    const row = await fb.setStatus(item.id, String(req.body.status || ''));
    res.json({ feedback: row });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:slug/:key/link', requirePermission('work:write'), async (req, res) => {
  const item = await itemByKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown feedback' });
  const [work] = await db.select().from(schema.workItems)
    .where(and(eq(schema.workItems.appId, req.app_.id), eq(schema.workItems.key, String(req.body.work || '').toUpperCase())))
    .limit(1);
  if (!work) return res.status(404).json({ error: 'Unknown work item' });
  if (req.body.remove) await fb.unlink(item.id, work.id);
  else await fb.link(item.id, work.id);
  res.json({ ok: true });
});

module.exports = router;
