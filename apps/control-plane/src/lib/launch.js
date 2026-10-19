'use strict';

// Signing in from another system ("launch").
//
// An operator names one outside system as a trusted launcher and shares a
// secret with it (settings launch.issuer / launch.origin / launch.secret). When someone opens an
// app from that system, it signs a short-lived pass and the browser posts it to
// POST /launch. The pass is an HS256 JWT:
//
//   iss    the launcher name, exactly as set here
//   aud    "astrodock-launch"
//   sub    the person's id in the launcher (recorded, never matched on)
//   email  the person's address, which the launcher has already verified
//   name   display name, used only when an account is created
//   app    the slug of the app being opened
//   jti    random, single-use
//   iat / exp   at most MAX_LIFETIME_S apart
//
// Trusting a launcher means trusting its sign-in: the launcher has checked who
// the person is, and its decision to show them the app is the grant. That is
// the whole point — people never see this platform's sign-in form.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, lt } = require('drizzle-orm');
const { db, schema } = require('../db');
const { getSetting, getSecretSetting } = require('./settings');

const AUDIENCE = 'astrodock-launch';
const MAX_LIFETIME_S = 300;
const CLOCK_TOLERANCE_S = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class LaunchError extends Error {
  constructor(title, message, status = 400) {
    super(message);
    this.title = title;
    this.status = status;
  }
}

async function launcher() {
  const issuer = String(await getSetting('launch.issuer', '') || '').trim();
  const origin = normalizeOrigin(await getSetting('launch.origin', ''));
  const secret = String(await getSecretSetting('launch.secret', '') || '');
  if (!issuer || !origin || secret.length < 32) return null;
  return { issuer, origin, secret };
}

function normalizeOrigin(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch { return ''; }
}

// The pass arrives as a cross-site form POST, so the browser always sends
// Origin. Requiring it to be the launcher's stops a page elsewhere from posting
// a pass someone obtained for themselves into a victim's browser.
function originAllowed(l, origin) {
  return !!origin && normalizeOrigin(origin) === l.origin;
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Check a pass and mark it used. Returns its claims, or throws LaunchError.
 */
async function redeemPass(token, { origin } = {}) {
  const l = await launcher();
  if (!l) throw new Error('not configured');
  if (!originAllowed(l, origin)) {
    throw new LaunchError('Open the app from its launcher', 'This sign-in has to start from the page your apps are listed on.', 403);
  }
  if (!token) throw new LaunchError('No pass', 'The request did not carry a launch pass.');

  let claims;
  try {
    claims = jwt.verify(String(token), l.secret, {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      issuer: l.issuer,
      clockTolerance: CLOCK_TOLERANCE_S
    });
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw new LaunchError(
      expired ? 'That link has expired' : 'That pass is not valid',
      expired ? 'Go back and open the app again.' : 'The pass could not be checked. Go back and open the app again.',
      401
    );
  }

  // Short-lived by construction, not by the launcher's good manners.
  if (!claims.exp || !claims.iat || claims.exp - claims.iat > MAX_LIFETIME_S) {
    throw new LaunchError('That pass is not valid', `A pass must expire within ${MAX_LIFETIME_S} seconds of being issued.`, 401);
  }
  if (!claims.jti || typeof claims.jti !== 'string') {
    throw new LaunchError('That pass is not valid', 'The pass has no id.', 401);
  }
  const email = String(claims.email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(email)) throw new LaunchError('That pass is not valid', 'The pass does not name an email address.', 401);
  const app = String(claims.app || '');
  if (!/^[a-z0-9-]{1,40}$/.test(app)) throw new LaunchError('That pass is not valid', 'The pass does not name an app.', 401);

  // Single use. The primary key makes a second redemption fail even when two
  // arrive at once.
  await db.delete(schema.launchPasses).where(lt(schema.launchPasses.expiresAt, new Date())).catch(() => {});
  const inserted = await db.insert(schema.launchPasses).values({
    jtiHash: hash(`${l.issuer}:${claims.jti}`),
    issuer: l.issuer,
    expiresAt: new Date((claims.exp + CLOCK_TOLERANCE_S) * 1000)
  }).onConflictDoNothing().returning();
  if (!inserted[0]) throw new LaunchError('That link was already used', 'Go back and open the app again.', 401);

  return {
    issuer: l.issuer,
    subject: String(claims.sub || ''),
    email,
    name: String(claims.name || '').trim().slice(0, 200) || email,
    app
  };
}

/**
 * The end user the pass names, created if new, with access to the app added.
 * Never touches an operator role. A disabled account stays disabled.
 */
async function resolveUser({ email, name }, app) {
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  let user = rows[0];
  let created = false;

  if (!user) {
    try {
      [user] = await db.insert(schema.users).values({
        email,
        name,
        passwordHash: null,
        passwordless: true,
        operatorRole: null,
        isAdmin: false,
        appAccess: [app.slug]
      }).returning();
      created = true;
    } catch {
      // Two launches for a new person at the same moment: the other one won.
      [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    }
  }
  if (!user) throw new LaunchError('Cannot sign you in', 'The account could not be created.', 500);
  if (!user.isActive) {
    throw new LaunchError('That account is disabled', 'Ask whoever manages your apps to turn it back on.', 403);
  }

  const access = Array.isArray(user.appAccess) ? user.appAccess : [];
  let granted = false;
  if (!access.includes(app.slug)) {
    await db.update(schema.users)
      .set({ appAccess: [...access, app.slug], updatedAt: new Date() })
      .where(eq(schema.users.id, user.id));
    user = { ...user, appAccess: [...access, app.slug] };
    granted = true;
  }
  return { user, created, granted };
}

module.exports = { AUDIENCE, MAX_LIFETIME_S, LaunchError, launcher, redeemPass, resolveUser };
