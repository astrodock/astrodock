'use strict';

// A single-use link that lets an owner with no way to sign in set one up.
//
// The hosted service creates the owner of a new instance by email (routes/fleet.js)
// and has no password to give them, so the account starts with no factor at all.
// This link is the one way in. It opens a session whose only job is the welcome
// page: add a passkey, or a password and an authenticator app.
//
// It works only while the account still has no password and no passkey. Once
// either exists, signing in is the way in, and a leaked old link is worthless.

const crypto = require('crypto');
const { and, eq, isNull, gt } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const factors = require('./auth-factors');

const TTL_MS = 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function needsSetup(userId) {
  return factors.primaryFactorCount(await factors.factorsFor(userId)) === 0;
}

function adminOrigin() {
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${config.adminSubdomain}.${config.baseDomain}`;
}

/**
 * Mint a link. `next` is a path on the dashboard to land on afterwards, for
 * example /connect/ABCD-EFGH when a CLI sign-in is waiting.
 */
async function create(userId, { next = '' } = {}) {
  const token = `os_${crypto.randomBytes(32).toString('base64url')}`;
  await db.insert(schema.ownerSetupLinks).values({
    tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + TTL_MS)
  });
  // The token goes in the fragment: fragments are not sent to the server, so it
  // stays out of access logs and Referer headers.
  const safeNext = typeof next === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(next) && !next.startsWith('//') ? next : '';
  const query = safeNext ? `?next=${encodeURIComponent(safeNext)}` : '';
  return { url: `${adminOrigin()}/welcome${query}#owner=${token}`, expiresAt: new Date(Date.now() + TTL_MS) };
}

/** Trade a link for the user it belongs to. Spent on the first attempt. */
async function redeem(token) {
  const hash = sha256(token || '');
  const [row] = await db.update(schema.ownerSetupLinks).set({ usedAt: new Date() })
    .where(and(
      eq(schema.ownerSetupLinks.tokenHash, hash),
      isNull(schema.ownerSetupLinks.usedAt),
      gt(schema.ownerSetupLinks.expiresAt, new Date())
    ))
    .returning();
  if (!row) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!user || !user.isActive || !user.operatorRole) return null;
  if (!await needsSetup(user.id)) return null;
  return user;
}

module.exports = { create, redeem, needsSetup, TTL_MS };
