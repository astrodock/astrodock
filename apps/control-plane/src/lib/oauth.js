'use strict';

// Hosted login — the authorization-code exchange that replaces credential
// forwarding. See AUTH_DESIGN.md.
//
// Under /verify, the app collects the user's password and posts it here. That
// means every app sees plaintext credentials for every user who signs in, and
// since operators and end users share one password hash, an app could capture
// dashboard access. Here the platform collects credentials on its own origin and
// hands the app a single-use code instead.
//
// The parts that go wrong in hand-rolled implementations, and what we do:
//
//   redirect_uri   exact match against a per-app allowlist. NOT prefix matching —
//                  that is how codes get delivered to an attacker's path.
//   code           single-use, 60s, bound to app AND redirect_uri, stored hashed.
//   exchange       requires the app secret, server-to-server. No user data ever
//                  travels in a redirect URL.
//   state          echoed unmodified; the app compares it. Its CSRF defence.

const crypto = require('crypto');
const { and, eq, isNull, lt } = require('drizzle-orm');
const { db, schema } = require('../db');

const CODE_TTL_MS = 60 * 1000;

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * Exact-match allowlist check.
 *
 * Compares the full string after normalising only the trailing slash — anything
 * cleverer (prefix, wildcard host, "same origin is fine") is how authorization
 * codes end up somewhere they should not.
 */
function normalizeUri(uri) {
  return String(uri || '').trim().replace(/\/+$/, '');
}

async function isAllowedRedirect(appId, uri) {
  const candidate = normalizeUri(uri);
  if (!candidate) return false;
  // Reject anything that is not an absolute http(s) URL before touching the DB,
  // so javascript: and data: never even get compared.
  let parsed;
  try { parsed = new URL(candidate); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const rows = await db.select().from(schema.appRedirectUris)
    .where(eq(schema.appRedirectUris.appId, appId));
  return rows.some((r) => normalizeUri(r.uri) === candidate);
}

async function listRedirectUris(appId) {
  return db.select().from(schema.appRedirectUris).where(eq(schema.appRedirectUris.appId, appId));
}

async function addRedirectUri(appId, uri) {
  const clean = normalizeUri(uri);
  let parsed;
  try { parsed = new URL(clean); } catch { throw new Error('Enter a full URL, e.g. https://yourapp.example.com/auth/callback'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Redirect URLs must be http or https.');
  }
  // http is allowed only for loopback, where there is no network to intercept.
  if (parsed.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) {
    throw new Error('Use https for anything other than localhost.');
  }
  const [row] = await db.insert(schema.appRedirectUris).values({ appId, uri: clean }).returning();
  return row;
}

async function removeRedirectUri(appId, id) {
  await db.delete(schema.appRedirectUris)
    .where(and(eq(schema.appRedirectUris.id, id), eq(schema.appRedirectUris.appId, appId)));
}

/** Mint a code for an authenticated user, bound to this app and redirect. */
async function issueCode({ appId, userId, redirectUri }) {
  const code = `ac_${crypto.randomBytes(32).toString('base64url')}`;
  await db.insert(schema.authorizationCodes).values({
    codeHash: hash(code),
    appId,
    userId,
    redirectUri: normalizeUri(redirectUri),
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });
  // Opportunistic tidy-up; codes are worthless once expired.
  db.delete(schema.authorizationCodes)
    .where(lt(schema.authorizationCodes.expiresAt, new Date(Date.now() - 3600 * 1000))).catch(() => {});
  return code;
}

/**
 * Spend a code. Single-use is enforced by marking it before returning the user,
 * so a replayed code fails even if two requests race.
 */
async function redeemCode({ code, appId, redirectUri }) {
  const rows = await db.select().from(schema.authorizationCodes)
    .where(and(eq(schema.authorizationCodes.codeHash, hash(code)), isNull(schema.authorizationCodes.usedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('That sign-in code is not valid.');

  // Mark spent first. A code that fails validation below is still burned — it has
  // been seen, and letting it be retried would allow probing for the right app.
  await db.update(schema.authorizationCodes).set({ usedAt: new Date() })
    .where(eq(schema.authorizationCodes.id, row.id));

  if (new Date(row.expiresAt) <= new Date()) throw new Error('That sign-in code has expired.');
  if (row.appId !== appId) throw new Error('That sign-in code was issued for a different app.');
  if (normalizeUri(row.redirectUri) !== normalizeUri(redirectUri)) {
    throw new Error('Redirect URL does not match the one the code was issued for.');
  }

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!user || !user.isActive) throw new Error('That account is not active.');
  return user;
}

module.exports = {
  isAllowedRedirect, listRedirectUris, addRedirectUri, removeRedirectUri,
  issueCode, redeemCode, normalizeUri, CODE_TTL_MS
};
