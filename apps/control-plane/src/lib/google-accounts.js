'use strict';

// Turning a verified Google identity into an account here.
//
// The rule that matters, and it is not symmetric:
//
//   AN OPERATOR ACCOUNT IS NEVER CREATED BY SIGNING IN.
//
// A dashboard login is an invitation. If Google hands us an address with no
// operator behind it, that is a stranger, and the answer is no — otherwise
// anyone with a Google account has a route to a platform dashboard. End users
// are different: their accounts are per-app and carry no platform privileges,
// so an app may opt into self-service signup, and that is the app owner's call
// rather than the platform's.
//
// Linking is by `sub`. Email is used exactly once, to find the account a `sub`
// should attach to on first sign-in, and only when Google says the address is
// verified. After that the address can change at Google without changing who
// this is here.

const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');

/** An existing account for this Google identity, or null. */
async function findLinked(sub) {
  if (!sub) return null;
  const rows = await db.select().from(schema.users).where(eq(schema.users.googleSub, sub)).limit(1);
  return rows[0] || null;
}

async function findByEmail(email) {
  if (!email) return null;
  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, String(email).toLowerCase())).limit(1);
  return rows[0] || null;
}

async function link(userId, identity) {
  await db.update(schema.users).set({
    googleSub: identity.sub,
    googleEmail: identity.email,
    googleLinkedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(schema.users.id, userId));
}

/**
 * Resolve a verified Google identity to an operator account.
 * Never creates one. Returns { user } or { error }.
 */
async function resolveOperator(identity) {
  const linked = await findLinked(identity.sub);
  if (linked) {
    if (!linked.operatorRole) return { error: 'That account does not have dashboard access.' };
    if (!linked.isActive) return { error: 'That account is disabled.' };
    return { user: linked };
  }

  // First sign-in: attach to an existing operator with the same verified
  // address. No match means no account, and we do not make one.
  const byEmail = identity.emailVerified ? await findByEmail(identity.email) : null;
  if (!byEmail) {
    return { error: 'No dashboard account uses that Google address. An operator has to invite you first.' };
  }
  if (!byEmail.operatorRole) return { error: 'That account does not have dashboard access.' };
  if (!byEmail.isActive) return { error: 'That account is disabled.' };
  if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
    return { error: 'That account is already linked to a different Google account.' };
  }

  await link(byEmail.id, identity);
  return { user: { ...byEmail, googleSub: identity.sub }, linked: true };
}

/**
 * Resolve a verified Google identity to an end user of one app.
 * Creates an account only when that app has opted in. Returns { user } or { error }.
 */
async function resolveEndUser(identity, app) {
  const linked = await findLinked(identity.sub);
  if (linked) {
    if (!linked.isActive) return { error: 'That account is disabled.' };
    return { user: linked, granted: await ensureAccess(linked, app) };
  }

  const byEmail = identity.emailVerified ? await findByEmail(identity.email) : null;
  if (byEmail) {
    if (!byEmail.isActive) return { error: 'That account is disabled.' };
    if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
      return { error: 'That account is already linked to a different Google account.' };
    }
    await link(byEmail.id, identity);
    return { user: { ...byEmail, googleSub: identity.sub }, linked: true, granted: await ensureAccess(byEmail, app) };
  }

  if (!app || !app.allowGoogleSignup) {
    return { error: 'There is no account for that Google address, and this app does not create them automatically.' };
  }

  // Self-service signup, for this app only. No operator role, ever: the column
  // is left null rather than defaulted, so a bug in role handling elsewhere
  // cannot promote someone who arrived this way.
  const [created] = await db.insert(schema.users).values({
    email: identity.email,
    name: identity.name || identity.email,
    passwordHash: null,
    passwordless: true,
    operatorRole: null,
    isAdmin: false,
    googleSub: identity.sub,
    googleEmail: identity.email,
    googleLinkedAt: new Date(),
    appAccess: [app.slug]
  }).returning();
  return { user: created, created: true };
}

/** Give an existing user access to this app if they do not have it yet. */
async function ensureAccess(user, app) {
  if (!app) return false;
  const access = Array.isArray(user.appAccess) ? user.appAccess : [];
  if (access.includes(app.slug)) return false;
  // Only when the app takes anyone with a Google account. Otherwise access is
  // something an operator grants, and a sign-in does not widen it.
  if (!app.allowGoogleSignup) return false;
  await db.update(schema.users)
    .set({ appAccess: [...access, app.slug], updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));
  return true;
}

module.exports = { resolveOperator, resolveEndUser, findLinked, link };
