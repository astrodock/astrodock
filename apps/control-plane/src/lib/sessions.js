'use strict';

// Dashboard sessions.
//
// Previously an 8-hour JWT with no server-side record, which meant a stolen
// session could not be revoked — the only remedy was rotating the signing secret
// and logging everyone out. The JWT now carries a session id checked on every
// request, so a single session can be killed.
//
// Also tracks `reauthAt` separately from session age: step-up actions require a
// RECENT factor check regardless of how long you have been signed in.

const jwt = require('jsonwebtoken');
const { and, eq, isNull, gt, lt } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');

const SESSION_HOURS = 8;
// How recently a factor must have been proven for a sensitive action. Long enough
// not to be infuriating during a working session, short enough that a walked-away
// laptop is not a platform takeover.
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

async function create(user, { ip = '', userAgent = '', reauthed = true } = {}) {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  const [session] = await db.insert(schema.sessions).values({
    userId: user.id,
    ip: String(ip || '').slice(0, 64),
    userAgent: String(userAgent || '').slice(0, 300),
    expiresAt,
    reauthAt: reauthed ? new Date() : null
  }).returning();

  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      isAdmin: true, // kept for tokens read by older code paths
      role: user.operatorRole || 'admin',
      sid: session.id
    },
    config.adminJwtSecret,
    { expiresIn: `${SESSION_HOURS}h` }
  );

  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  return { token, session };
}

/**
 * The sessions that could still sign in as this person.
 *
 * Expiry was not part of the question, so "Where you're signed in" listed every
 * session ever created that nobody had explicitly revoked. On the live platform
 * that was 18 rows going back to July, of which exactly one was live: a list of
 * dead sessions presented as active, next to a Sign out button that did nothing
 * anyone could observe. A session expires after SESSION_HOURS whether or not a
 * row says so.
 */
async function listFor(userId) {
  return db.select().from(schema.sessions)
    .where(and(
      eq(schema.sessions.userId, userId),
      isNull(schema.sessions.revokedAt),
      gt(schema.sessions.expiresAt, new Date())
    ));
}

/**
 * Delete sessions that expired a while ago.
 *
 * Nothing ever removed them, so the table only grew. Kept for a week past expiry
 * so "signed in from Lisbon on Tuesday" is still answerable after the fact, which
 * is the one reason to hold a dead session at all.
 */
async function pruneExpired({ olderThanDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400 * 1000);
  const gone = await db.delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, cutoff)).returning({ id: schema.sessions.id });
  return gone.length;
}

async function revoke(sessionId) {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, sessionId));
}

async function revokeAllFor(userId, { except = null } = {}) {
  const rows = await listFor(userId);
  for (const s of rows) if (s.id !== except) await revoke(s.id);
  return rows.filter((s) => s.id !== except).length;
}

/** Mark the current session as having just proven a factor. */
async function markReauth(sessionId) {
  await db.update(schema.sessions).set({ reauthAt: new Date() }).where(eq(schema.sessions.id, sessionId));
}

function reauthIsFresh(reauthAt) {
  return !!reauthAt && (Date.now() - new Date(reauthAt).getTime()) < REAUTH_WINDOW_MS;
}

/**
 * Express guard for sensitive actions. Keys are exempt: a key IS the credential,
 * and there is nobody present to re-prompt.
 */
function requireRecentAuth(req, res, next) {
  const auth = req.auth;
  if (!auth) return res.status(401).json({ error: 'Authentication required' });
  if (auth.type === 'token') return next();
  if (reauthIsFresh(auth.reauthAt)) return next();
  return res.status(403).json({
    error: 'Please confirm it is you before continuing.',
    code: 'reauth_required'
  });
}

module.exports = {
  create, listFor, revoke, revokeAllFor, markReauth, reauthIsFresh, requireRecentAuth,
  pruneExpired,
  SESSION_HOURS, REAUTH_WINDOW_MS
};
