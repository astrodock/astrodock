'use strict';

// Who someone is on an artifact, and how they got there.
//
// Each artifact is its own origin (<public_id>.<artifacts domain>) with its own
// session cookie, host-only. The sign-in itself happens on the auth host:
//   - a person on the account (an operator) with a platform session is sent
//     straight back, no prompt;
//   - anyone else gets a 6-digit code by email, for this artifact only.
// Either way the auth host hands the artifact host a one-time grant, which the
// artifact host exchanges for its session.
//
// A session is re-checked on every request: the account must still be active,
// the artifact's session epoch unchanged, and the person still the owner or on
// the share list. Removing a share ends their access at once.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, and, gt, isNull, sql } = require('drizzle-orm');
const config = require('../../config');
const { db, schema } = require('../../db');
const roles = require('../roles');

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generatePublicId() {
  // Rejection sampling, so every character is equally likely.
  let s = '';
  while (s.length < 12) {
    const b = crypto.randomBytes(16);
    for (const x of b) { if (x < 252 && s.length < 12) s += ID_ALPHABET[x % 36]; }
  }
  return s;
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (e) => EMAIL.test(e) && e.length <= 254;

function sessionKey() {
  return crypto.createHash('sha256').update(`${config.secretKey || config.adminJwtSecret}:artifact-sessions`).digest();
}

const SESSION_BASE = 'ad_artifact';
const SESSION_DAYS = 30;
function cookieName() { return config.tlsMode !== 'off' ? `__Host-${SESSION_BASE}` : SESSION_BASE; }
function cookieOptions() {
  // Lax, not Strict: the sign-in ends with a redirect from the auth host, and a
  // link in an email is a cross-site navigation too. Strict would drop the
  // cookie on both. Cross-site writes are refused by the Origin check instead.
  return { httpOnly: true, sameSite: 'lax', secure: config.tlsMode !== 'off', maxAge: SESSION_DAYS * 864e5, path: '/' };
}

function signSession(artifact, user) {
  return jwt.sign({ sub: user.id, email: user.email, aid: artifact.id, ep: artifact.sessionEpoch }, sessionKey(), { expiresIn: `${SESSION_DAYS}d` });
}

function readSession(req, artifact) {
  const raw = req.cookies?.[cookieName()];
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, sessionKey());
    if (p.aid !== artifact.id || p.ep !== artifact.sessionEpoch) return null;
    return p;
  } catch { return null; }
}

async function loadArtifact(publicId) {
  const [a] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.publicId, String(publicId))).limit(1);
  return a || null;
}

async function loadUser(id) {
  if (!id) return null;
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u && u.isActive ? u : null;
}

async function shareFor(artifactId, email) {
  const [s] = await db.select().from(schema.artifactShares)
    .where(and(eq(schema.artifactShares.artifactId, artifactId), eq(schema.artifactShares.email, normEmail(email)))).limit(1);
  return s || null;
}

/**
 * The role a person holds on an artifact, or null. The owner is always the top
 * role. A share whose role the manifest no longer defines falls to the lowest.
 */
async function roleFor(artifact, manifest, user) {
  if (!user) return null;
  if (artifact.ownerId && artifact.ownerId === user.id) return manifest.roles[0];
  const s = await shareFor(artifact.id, user.email);
  if (!s) return null;
  return manifest.roles.includes(s.role) ? s.role : manifest.roles[manifest.roles.length - 1];
}

/** Does this person have any access at all? */
async function hasAccess(artifact, user) {
  if (!user) return false;
  if (artifact.ownerId && artifact.ownerId === user.id) return true;
  return !!(await shareFor(artifact.id, user.email));
}

/** People on the account sign in without a code. */
function isAccountMember(user) { return roles.isOperator(user); }

// ── grants: auth host → artifact host ──────────────────────────────────────
async function issueGrant(artifact, user) {
  const code = crypto.randomBytes(24).toString('base64url');
  await db.insert(schema.artifactGrants).values({
    codeHash: hash(code), artifactId: artifact.id, userId: user.id,
    expiresAt: new Date(Date.now() + 2 * 60 * 1000)
  });
  return code;
}

/** Spend a grant. Returns the user, or null. One use, two minutes. */
async function redeemGrant(artifact, code) {
  if (!code) return null;
  const rows = await db.update(schema.artifactGrants).set({ usedAt: new Date() })
    .where(and(
      eq(schema.artifactGrants.codeHash, hash(code)),
      eq(schema.artifactGrants.artifactId, artifact.id),
      isNull(schema.artifactGrants.usedAt),
      gt(schema.artifactGrants.expiresAt, new Date())
    )).returning();
  if (!rows[0]) return null;
  return loadUser(rows[0].userId);
}

// ── email codes ────────────────────────────────────────────────────────────
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** How many codes went to this address in the last hour. */
async function recentCodeCount(email) {
  const [r] = await db.select({ n: sql`count(*)::int` }).from(schema.artifactCodes)
    .where(and(eq(schema.artifactCodes.email, normEmail(email)), gt(schema.artifactCodes.createdAt, new Date(Date.now() - 3600e3))));
  return r ? r.n : 0;
}

async function createCode(artifact, email, ip) {
  const code = generateCode();
  await db.insert(schema.artifactCodes).values({
    artifactId: artifact.id, email: normEmail(email), codeHash: hash(`${artifact.id}:${code}`),
    ip: ip || '', expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });
  return code;
}

/**
 * Check a code. Only the newest unexpired code for the address counts, and each
 * wrong try uses one of five attempts. Returns true once, then the code is spent.
 */
async function checkCode(artifact, email, code) {
  const e = normEmail(email);
  const [row] = await db.select().from(schema.artifactCodes)
    .where(and(eq(schema.artifactCodes.artifactId, artifact.id), eq(schema.artifactCodes.email, e),
      isNull(schema.artifactCodes.usedAt), gt(schema.artifactCodes.expiresAt, new Date())))
    .orderBy(sql`created_at desc`).limit(1);
  if (!row || row.attempts >= CODE_ATTEMPTS) return false;
  const given = hash(`${artifact.id}:${String(code || '').replace(/\s/g, '')}`);
  const ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.codeHash));
  if (!ok) {
    await db.update(schema.artifactCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.artifactCodes.id, row.id));
    return false;
  }
  const spent = await db.update(schema.artifactCodes).set({ usedAt: new Date() })
    .where(and(eq(schema.artifactCodes.id, row.id), isNull(schema.artifactCodes.usedAt))).returning();
  return !!spent[0];
}

/**
 * The account for an email, created when it is someone's first sign-in. A
 * person created here is an end user: no dashboard, no app access.
 */
async function userForEmail(email) {
  const e = normEmail(email);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, e)).limit(1);
  if (u) return u.isActive ? u : null;
  const rows = await db.insert(schema.users).values({
    email: e, name: e.split('@')[0], passwordHash: null, passwordless: true, isActive: true, operatorRole: null, appAccess: []
  }).onConflictDoNothing().returning();
  if (rows[0]) return rows[0];
  const [again] = await db.select().from(schema.users).where(eq(schema.users.email, e)).limit(1);
  return again && again.isActive ? again : null;
}

module.exports = {
  generatePublicId, hash, normEmail, validEmail,
  cookieName, cookieOptions, signSession, readSession,
  loadArtifact, loadUser, shareFor, roleFor, hasAccess, isAccountMember,
  issueGrant, redeemGrant,
  recentCodeCount, createCode, checkCode, userForEmail, CODE_TTL_MS
};
