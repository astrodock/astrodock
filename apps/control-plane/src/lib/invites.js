'use strict';

// Inviting someone to an app, rather than choosing their password for them.
//
// Before this, creating an end user meant POSTing a password. Whoever ran the
// dashboard picked a password for another person and then had to send it to
// them somehow, which is the worst available way to start an account.
//
// An invite inverts that. The account is created with no credential and no
// access to anything. A link goes out. Whoever opens it establishes their own
// credential — a Google account or a password — and only then does the account
// gain access to the app.
//
// Two details that are load-bearing:
//
//   The gate is app_access, not is_active. An invited account can be found by
//   email, so it has to be inert without being disabled: resolveEndUser refuses
//   a disabled account outright, which would block the Google link we are
//   trying to let them make. With no password hash and no app in app_access,
//   both sign-in paths already decline on their own.
//
//   The token is stored as a hash. It is returned exactly once, to the caller
//   that created the invite, because that caller is the one sending the email.

const crypto = require('crypto');
const { eq, and, isNull } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');

const DEFAULT_TTL_DAYS = 14;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Every hostname this app legitimately answers on: its platform subdomain plus
 * any custom domain that has actually been verified. A pending domain does not
 * count — it is a hostname someone has claimed, not one they have proven.
 */
async function appHostnames(app) {
  const hosts = [];
  if (config.baseDomain && app.subdomain) hosts.push(`${app.subdomain}.${config.baseDomain}`.toLowerCase());
  const rows = await db.select({ hostname: schema.customDomains.hostname })
    .from(schema.customDomains)
    .where(and(eq(schema.customDomains.appId, app.id), eq(schema.customDomains.status, 'active')));
  for (const r of rows) hosts.push(String(r.hostname).toLowerCase());
  return hosts;
}

/**
 * Is this URL somewhere the app actually lives? An invite ends in a redirect,
 * and a redirect an outsider can choose is an open redirect, so the answer has
 * to come from the app's own hostnames rather than from the request.
 */
async function isAllowedRedirect(app, url) {
  if (!url) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && !(config.tlsMode === 'off' && u.protocol === 'http:')) return false;
  return (await appHostnames(app)).includes(u.hostname.toLowerCase());
}

/**
 * Where to send someone once the invite is redeemed: whatever the app asked
 * for, or the app's own front door if it asked for nothing.
 */
async function landingUrl(invite, app) {
  if (invite.redirectTo && await isAllowedRedirect(app, invite.redirectTo)) return invite.redirectTo;
  const [host] = await appHostnames(app);
  if (!host) return '';
  return `${config.tlsMode === 'off' ? 'http' : 'https'}://${host}/`;
}

/** Where the invite link itself points. */
function inviteUrl(token) {
  const base = config.authBaseUrl();
  return base ? `${base}/invite/${token}` : '';
}

/**
 * Create an invite for an account, making the account first if there is none.
 *
 * An existing account is reused rather than refused: inviting someone who
 * already signs in to another app on this box should give them this app too,
 * not an error telling the operator to go and do it by hand.
 *
 * Returns { invite, user, token, url, existingUser }. The token is the only
 * copy; it is not recoverable afterwards.
 */
async function create({ email, name, app, invitedByName = '', redirectTo = '', ttlDays = DEFAULT_TTL_DAYS }) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) throw new Error('An email address is required');
  if (!app) throw new Error('An app is required');
  if (redirectTo && !await isAllowedRedirect(app, redirectTo)) {
    throw new Error('That return address is not one of this app\'s hostnames');
  }

  const found = await db.select().from(schema.users).where(eq(schema.users.email, addr)).limit(1);
  let user = found[0] || null;
  const existingUser = !!user;

  if (!user) {
    const rows = await db.insert(schema.users).values({
      email: addr,
      name: String(name || '').trim() || addr,
      passwordHash: null,
      // Not an operator, ever. Left null rather than defaulted, for the same
      // reason google-accounts gives: a bug in role handling elsewhere must not
      // be able to promote someone who arrived this way.
      operatorRole: null,
      isAdmin: false,
      appAccess: []
    }).returning();
    user = rows[0];
  } else if (!user.isActive) {
    throw new Error('That account is disabled');
  }

  // Supersede anything still outstanding for this person and app, so an invite
  // that was resent cannot be redeemed twice from two different emails.
  await db.update(schema.userInvites)
    .set({ redeemedAt: new Date() })
    .where(and(
      eq(schema.userInvites.userId, user.id),
      eq(schema.userInvites.appId, app.id),
      isNull(schema.userInvites.redeemedAt)
    ));

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS) * 864e5);
  const [invite] = await db.insert(schema.userInvites).values({
    userId: user.id,
    appId: app.id,
    tokenHash: hashToken(token),
    invitedByName: String(invitedByName || '').slice(0, 120),
    redirectTo: String(redirectTo || ''),
    expiresAt
  }).returning();

  return { invite, user, token, url: inviteUrl(token), existingUser };
}

/**
 * Look an invite up by its token. Returns { invite, user, app } or { error }.
 * The error strings are shown to whoever followed the link, so they say what
 * happened rather than "invalid".
 */
async function resolve(token) {
  if (!token) return { error: 'That invite link is incomplete.' };
  const rows = await db.select().from(schema.userInvites)
    .where(eq(schema.userInvites.tokenHash, hashToken(token))).limit(1);
  const invite = rows[0];
  if (!invite) return { error: 'That invite link is not valid. Ask for a new one.' };
  if (invite.redeemedAt) return { error: 'That invite has already been used. Sign in instead.' };
  if (new Date(invite.expiresAt) <= new Date()) return { error: 'That invite has expired. Ask for a new one.' };

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, invite.userId)).limit(1);
  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, invite.appId)).limit(1);
  if (!user || !app) return { error: 'That invite points at something that no longer exists.' };
  if (!user.isActive) return { error: 'That account is disabled.' };
  return { invite, user, app };
}

/**
 * Mark the invite used and give the account access to the app.
 *
 * `userId` is passed separately because redeeming with Google may land on an
 * account that already existed under a different address than the one invited.
 * In that case the invited placeholder is the wrong row to grant, and the
 * account that actually signed in is the right one.
 */
async function redeem({ invite, userId }) {
  const id = userId || invite.userId;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!user) throw new Error('That account no longer exists');

  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, invite.appId)).limit(1);
  if (!app) throw new Error('That app no longer exists');

  const access = Array.isArray(user.appAccess) ? user.appAccess : [];
  if (!access.includes(app.slug)) {
    await db.update(schema.users)
      .set({ appAccess: [...access, app.slug], updatedAt: new Date() })
      .where(eq(schema.users.id, user.id));
  }

  // Conditional on still being open, so two tabs racing cannot both redeem.
  const done = await db.update(schema.userInvites)
    .set({ redeemedAt: new Date() })
    .where(and(eq(schema.userInvites.id, invite.id), isNull(schema.userInvites.redeemedAt)))
    .returning({ id: schema.userInvites.id });
  if (!done[0]) throw new Error('That invite has already been used.');

  return { ...user, appAccess: access.includes(app.slug) ? access : [...access, app.slug] };
}

/**
 * The placeholder account made for an invite that was then redeemed by a
 * different, pre-existing account. Nothing has ever signed in as it and nothing
 * references it, so it is removed rather than left as a duplicate of a person.
 */
async function discardPlaceholder(userId) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return false;
  const access = Array.isArray(u.appAccess) ? u.appAccess : [];
  const untouched = !u.passwordHash && !u.googleSub && !u.operatorRole && !u.lastLoginAt && access.length === 0;
  if (!untouched) return false;
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  return true;
}

module.exports = {
  create, resolve, redeem, discardPlaceholder, landingUrl,
  isAllowedRedirect, appHostnames, inviteUrl, hashToken, DEFAULT_TTL_DAYS
};
