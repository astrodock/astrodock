'use strict';

const express = require('express');
const { eq, and, isNull } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { hashPassword } = require('../lib/passwords');
const factors = require('../lib/auth-factors');
const { accountLimiter } = require('../middleware/rateLimiter');
const userSession = require('../lib/user-session');
const google = require('../lib/google');
const googleAccounts = require('../lib/google-accounts');
const accountEmail = require('../lib/account-email');
const { shell, esc, errorPage, icon } = require('../lib/auth-pages');

const router = express.Router();

// Every write here is ridden by the platform session cookie, and every app on
// the platform is same-site with this host, so SameSite=Lax does not keep an
// app's own script from sending it. A write is accepted only from this host's
// own page. Browsers send Sec-Fetch-Site on every request they make; Origin is
// checked as well for the ones that predate it. A request with neither is not
// from a browser, so it carries no cookie worth riding.
function sameOriginWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'This can only be changed from the account page itself.' });
  }
  const origin = req.headers.origin;
  const own = config.authBaseUrl();
  if (origin && own && origin !== own) {
    return res.status(403).json({ error: 'This can only be changed from the account page itself.' });
  }
  next();
}
router.use(sameOriginWrites);

function logAttempt(email, result, ip) {
  console.log(`[account] ${new Date().toISOString()} | ${result} | email=${email} | ip=${ip}`);
  db.insert(schema.authLogs).values({ email, appId: 'account', result, ip: ip || '' }).catch(() => {});
}

// End-user self-service password change (used by the hosted /account page).
//
// One answer for every way it can fail — no account, disabled, no password,
// wrong password — so this is not a way to learn which addresses have accounts.
// An account with two-step sign-in also needs its code, as it would to sign in.
router.post('/change-password', accountLimiter, async (req, res) => {
  const { email, currentPassword, newPassword, totp, recoveryCode } = req.body || {};
  const ip = req.ip || '';

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'email, currentPassword, and newPassword are required' });
  }
  if (String(newPassword).length < factors.MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `New password must be at least ${factors.MIN_PASSWORD_LENGTH} characters` });
  }

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, String(email).toLowerCase().trim())).limit(1);
  const user = rows[0];
  if (!user || !user.isActive || !await factors.checkPassword(user, currentPassword)) {
    logAttempt(email, !user ? 'USER_NOT_FOUND' : (!user.isActive ? 'INACTIVE_USER' : 'PASSWORD_CHANGE_BAD_PASSWORD'), ip);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }

  const f = await factors.factorsFor(user.id);
  if (f.totp) {
    if (!totp && !recoveryCode) {
      return res.status(401).json({ error: 'Enter the code from your authenticator app.', code: 'totp_required' });
    }
    const ok = recoveryCode
      ? await factors.consumeRecoveryCode(user.id, recoveryCode)
      : await factors.checkTotp(user, totp);
    if (!ok) {
      logAttempt(email, 'PASSWORD_CHANGE_BAD_2FA', ip);
      return res.status(401).json({ error: 'That code is not right.', code: 'totp_required' });
    }
  }

  const passwordHash = await hashPassword(String(newPassword));
  await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  logAttempt(email, 'PASSWORD_CHANGED', ip);
  res.json({ message: 'Password updated successfully' });
});

// ── signed-in self-service ───────────────────────────────────────────────────
//
// Everything below needs the platform session, which lives on this host and is
// set when someone signs into any app. The password change above deliberately
// does not: it is reachable by someone who only has their password, which is
// the one thing they would come here with.
//
// Why this exists at all: the address an account signs in with was unchangeable
// anywhere — the admin PATCH ignored it, the admin panel disabled the field,
// and this page only did passwords. And resolveEndUser can only attach a Google
// identity whose verified address already matches the account, so a person
// invited at one address who uses a different Google account had no route in.

async function sessionUser(req) {
  const session = userSession.read(req);
  if (!session) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.sub)).limit(1);
  return user && user.isActive ? user : null;
}

function requireSession(handler) {
  return async (req, res) => {
    const user = await sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in to an app first, then come back here.' });
    return handler(req, res, user);
  };
}

// What the page renders itself from. 401 when not signed in, which is how the
// page knows to show only the password form.
router.get('/me', accountLimiter, requireSession(async (req, res, user) => {
  const creds = await db.select({ id: schema.webauthnCredentials.id })
    .from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, user.id));
  const pending = await db.select({ newEmail: schema.emailChanges.newEmail })
    .from(schema.emailChanges)
    .where(and(eq(schema.emailChanges.userId, user.id), isNull(schema.emailChanges.confirmedAt)))
    .limit(1);
  res.json({
    email: user.email,
    name: user.name,
    hasPassword: !!user.passwordHash,
    hasTotp: !!(user.totpSecret && user.totpConfirmedAt),
    passkeys: creds.length,
    google: { linked: !!user.googleSub, email: user.googleEmail || '' },
    googleAvailable: await google.configured().catch(() => false),
    pendingEmail: pending[0] ? pending[0].newEmail : null,
    apps: Array.isArray(user.appAccess) ? user.appAccess : []
  });
}));

// ── attaching a Google account ───────────────────────────────────────────────

function googleCallbackUrl(req) {
  const scheme = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${scheme}://${req.get('host')}/login/google/callback`;
}

router.get('/google/link', accountLimiter, async (req, res) => {
  const user = await sessionUser(req);
  if (!user) {
    return res.status(401).type('html').send(errorPage('Sign In First',
      'Open one of your apps and sign in, then come back to this page.'));
  }
  try {
    const { url } = await google.begin({
      redirectUri: googleCallbackUrl(req),
      // The session is re-read at the callback rather than trusted from here, so
      // a link cannot be aimed at somebody else's account.
      context: { surface: 'link', userId: user.id }
    });
    res.redirect(url);
  } catch (err) {
    res.type('html').send(errorPage('Google Sign-In Unavailable', err.message));
  }
});

router.post('/google/unlink', accountLimiter, express.json(), requireSession(async (req, res, user) => {
  try {
    await googleAccounts.unlinkFromUser(user.id);
    res.json({ message: 'That Google account is no longer attached.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── changing the sign-in address ─────────────────────────────────────────────

router.post('/email', accountLimiter, express.json(), requireSession(async (req, res, user) => {
  // The session alone is not enough to move the account to another address: a
  // session left open on a shared machine would otherwise be enough to take the
  // account over. The person proves it is them with the factor they have — the
  // password, or the authenticator code when there is no password.
  if (user.passwordHash) {
    if (!await factors.checkPassword(user, req.body?.currentPassword)) {
      logAttempt(user.email, 'EMAIL_CHANGE_BAD_PASSWORD', req.ip || '');
      return res.status(401).json({ error: 'Your current password is not right.' });
    }
  } else if (user.totpSecret && user.totpConfirmedAt) {
    if (!await factors.checkTotp(user, req.body?.totp)) {
      logAttempt(user.email, 'EMAIL_CHANGE_BAD_2FA', req.ip || '');
      return res.status(401).json({ error: 'That code is not right.' });
    }
  }
  try {
    const row = await accountEmail.request({ user, newEmail: req.body?.email });
    logAttempt(user.email, 'EMAIL_CHANGE_REQUESTED', req.ip || '');
    res.json({
      message: `Check ${row.newEmail} for a link. Nothing changes until you follow it.`,
      pendingEmail: row.newEmail
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Followed from the new address's inbox, so it cannot require a session: the
// token is the proof, and the person may well be in a different browser.
router.get('/email/confirm/:token', accountLimiter, async (req, res) => {
  try {
    const { to, from } = await accountEmail.confirm(req.params.token);
    logAttempt(to, 'EMAIL_CHANGED', req.ip || '');
    // The session carries the old address in its claims, so it is cleared: the
    // next sign-in mints one that matches the account.
    userSession.clear(res);
    res.type('html').send(shell('Address Confirmed', `
<span class="tile success">${icon('check')}</span>
<div class="heading"><h1>That Is Your Address Now</h1>
<p class="sub">This account signs in as <b>${esc(to)}</b> instead of ${esc(from)}.</p></div>
<p class="muted">Sign in again to continue.</p>`));
  } catch (err) {
    res.status(400).type('html').send(errorPage('That Link Cannot Be Used', err.message, { icon: 'link' }));
  }
});

module.exports = router;
