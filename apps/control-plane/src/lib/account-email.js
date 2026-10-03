'use strict';

// Changing the address an account signs in with.
//
// Two paths, and they are deliberately asymmetric.
//
// An OPERATOR sets it directly. They are already trusted to create accounts and
// grant app access, and the case this exists for is a typo in an invite, which
// a verification round trip would not help: the address is wrong precisely
// because nobody can read mail there.
//
// A PERSON changing their OWN address has to prove they control the new one.
// Without that, someone could park their account on a colleague's address, and
// the next invite sent to that colleague would find the account already holding
// it and hand them the wrong one. The old address is told either way, so a
// change nobody asked for is visible to the person it happened to.

const crypto = require('crypto');
const { eq, and, isNull, ne } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { sendEmail } = require('./email');
const emailConfig = require('./email-config');
const { emitEvent } = require('./events');

const TTL_MINUTES = 60;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

// Deliberately loose. The confirmation mail is the real check for a
// self-service change, and an operator setting an odd-looking internal address
// should not be argued with.
function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Nobody else may already be using it. */
async function assertFree(email, exceptUserId) {
  const rows = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.email, email), ne(schema.users.id, exceptUserId))).limit(1);
  if (rows[0]) throw new Error('Another account here already uses that address');
}

/**
 * Operator change. Applies at once; the Google link is keyed on the subject id
 * rather than the address, so it survives.
 */
async function setByOperator({ userId, newEmail, actor }) {
  const email = normalize(newEmail);
  if (!looksLikeEmail(email)) throw new Error('That does not look like an email address');
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new Error('User not found');
  if (email === user.email) return user;
  await assertFree(email, userId);

  const [updated] = await db.update(schema.users)
    .set({ email, updatedAt: new Date() }).where(eq(schema.users.id, userId)).returning();

  // Both addresses, because the person may only be able to read one of them.
  await notify(user.email, email, user.name, true).catch(() => {});
  emitEvent({
    category: 'audit',
    type: 'user.email_changed',
    actorType: 'admin',
    actor: actor || 'operator',
    targetType: 'user',
    targetId: userId,
    message: `Sign-in address changed from ${user.email} to ${email}`,
    meta: { from: user.email, to: email, verified: false }
  }).catch(() => {});
  return updated;
}

/**
 * Self-service request. Sends a confirmation link to the NEW address and a
 * notice to the old one. Nothing changes until the link is followed.
 */
async function request({ user, newEmail }) {
  const email = normalize(newEmail);
  if (!looksLikeEmail(email)) throw new Error('That does not look like an email address');
  if (email === user.email) throw new Error('That is already your address');
  await assertFree(email, user.id);

  // Refuse loudly rather than silently: sendEmail returns null when no provider
  // is set up, which would leave someone waiting for mail that was never sent.
  if (!emailConfig.isUsable(await emailConfig.resolve())) {
    throw new Error('This server cannot send email yet, so an address change cannot be confirmed. An administrator can change it for you.');
  }

  // One live request at a time, so an older link in an older inbox stops working.
  await db.update(schema.emailChanges).set({ confirmedAt: new Date() })
    .where(and(eq(schema.emailChanges.userId, user.id), isNull(schema.emailChanges.confirmedAt)));

  const token = crypto.randomBytes(32).toString('base64url');
  const [row] = await db.insert(schema.emailChanges).values({
    userId: user.id,
    newEmail: email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TTL_MINUTES * 60e3)
  }).returning();

  const base = config.authBaseUrl();
  const link = `${base}/account/email/confirm/${token}`;
  await sendEmail({
    to: email,
    subject: 'Confirm your new sign-in address',
    html: `<p>Hello${user.name ? ` ${esc(user.name)}` : ''},</p>`
      + `<p>You asked to sign in with this address instead of <b>${esc(user.email)}</b>. Confirm it:</p>`
      + `<p><a href="${esc(link)}">${esc(link)}</a></p>`
      + `<p>The link works once and expires in ${TTL_MINUTES} minutes. If you did not ask for this, ignore it and nothing changes.</p>`
  });
  await notify(user.email, email, user.name, false).catch(() => {});
  return row;
}

/** Follow the link. Returns { user, from, to } or throws with a plain sentence. */
async function confirm(token) {
  if (!token) throw new Error('That link is incomplete');
  const [row] = await db.select().from(schema.emailChanges)
    .where(eq(schema.emailChanges.tokenHash, hashToken(token))).limit(1);
  if (!row) throw new Error('That link is not valid. Ask for a new one.');
  if (row.confirmedAt) throw new Error('That link has already been used.');
  if (new Date(row.expiresAt) <= new Date()) throw new Error('That link has expired. Ask for a new one.');

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!user) throw new Error('That account no longer exists');
  // Checked again here: an address free an hour ago may have been taken since.
  await assertFree(row.newEmail, user.id);

  // Conditional, so two clicks cannot both apply it.
  const done = await db.update(schema.emailChanges).set({ confirmedAt: new Date() })
    .where(and(eq(schema.emailChanges.id, row.id), isNull(schema.emailChanges.confirmedAt)))
    .returning({ id: schema.emailChanges.id });
  if (!done[0]) throw new Error('That link has already been used.');

  await db.update(schema.users)
    .set({ email: row.newEmail, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  emitEvent({
    category: 'audit',
    type: 'user.email_changed',
    actorType: 'system',
    actor: row.newEmail,
    targetType: 'user',
    targetId: user.id,
    message: `${user.email} confirmed a change of sign-in address to ${row.newEmail}`,
    meta: { from: user.email, to: row.newEmail, verified: true }
  }).catch(() => {});
  return { user, from: user.email, to: row.newEmail };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tell the old address. A change nobody asked for has to be visible. */
async function notify(oldEmail, newEmail, name, applied) {
  return sendEmail({
    to: oldEmail,
    subject: applied ? 'Your sign-in address was changed' : 'Someone asked to change your sign-in address',
    html: `<p>Hello${name ? ` ${esc(name)}` : ''},</p>`
      + (applied
        ? `<p>This account now signs in as <b>${esc(newEmail)}</b> instead of <b>${esc(oldEmail)}</b>.</p>`
        : `<p>A request was made to change this account's sign-in address to <b>${esc(newEmail)}</b>. `
          + 'It does not take effect until someone confirms it from that address.</p>')
      + '<p>If this was not you, contact whoever runs this server.</p>'
  });
}

module.exports = { setByOperator, request, confirm, normalize, looksLikeEmail, hashToken, TTL_MINUTES };
