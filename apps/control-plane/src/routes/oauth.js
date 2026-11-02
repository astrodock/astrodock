'use strict';

// Public hosted-login endpoints. Mounted at the root, not under /admin, because
// end users reach these — they are the sign-in surface for deployed apps.
//
//   GET  /authorize   browser lands here from the app; we authenticate and bounce back
//   POST /login       the hosted login page submits here (password, or passkey)
//   POST /token       the app's SERVER exchanges the code, with its app secret
//
// The mobile app signs in through the same page and the same /login handler.
// GET /mobile/authorize (routes/mobile.js) renders this page with a `mobile`
// target in place of an app, and /login, Google and passkey sign-in each finish
// that target by issuing a PKCE code for the app instead (finishMobile below).

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const oauth = require('../lib/oauth');
const userSession = require('../lib/user-session');
const factors = require('../lib/auth-factors');
const passkeys = require('../lib/passkeys');
const google = require('../lib/google');
const googleAccounts = require('../lib/google-accounts');
const invites = require('../lib/invites');
const mobile = require('../lib/mobile');

// Registered once on the Google client and shared by every app: the app being
// signed into travels in the sign-in's own context, not in the redirect URI.
function googleCallbackUrl(req) {
  const scheme = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${scheme}://${req.get('host')}/login/google/callback`;
}
const { decryptSecret } = require('../lib/crypto');
// The page shell, shared with the invite redemption page: the same surface at
// two moments, so one stylesheet.
const { esc, scriptJson, safeColor, shell, errorPage, brandMark, googleButton, icon, errorLine, passwordField, REVEAL_JS } = require('../lib/auth-pages');
const { emitEvent } = require('../lib/events');
// The hosted sign-in is the replacement for /verify, which was rate limited.
// This one was not — same exposure, no throttle.
const { pageLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Constant-time compare, as /verify does. The length check leaks only length,
// and app secrets are a fixed format.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function logAttempt(email, appId, result, ip) {
  db.insert(schema.authLogs).values({ email: email || '', appId: appId || '', result, ip: ip || '' }).catch(() => {});
}

async function appBySlug(slug) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, String(slug || ''))).limit(1);
  return rows[0] || null;
}

// ── /.well-known/webauthn ─────────────────────────────────────────────────────
// Served on the admin host (the RP ID). Lists the hosted sign-in's origin so a
// browser lets the login page on auth.<domain> use passkeys bound to the admin
// host. Public, and must not redirect.
router.get('/.well-known/webauthn', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ origins: passkeys.relatedOrigins() });
});

// ── /authorize ────────────────────────────────────────────────────────────────
// Validates the request, then serves the hosted login page. Everything the page
// needs is embedded server-side; nothing sensitive is in the query string.
router.get('/authorize', async (req, res) => {
  const { app_id: appId, redirect_uri: redirectUri, state = '', nonce = '' } = req.query;

  const app = await appBySlug(appId);
  if (!app) return res.status(400).type('html').send(errorPage('Unknown App', 'That application is not registered on this server.'));

  // Validate the redirect BEFORE anything else can bounce a user to it.
  if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
    return res.status(400).type('html').send(errorPage(
      'Redirect URL Not Allowed',
      'This app has not registered that redirect URL. An administrator can add it in the app\'s settings.'
    ));
  }

  // Already signed in to the platform? Then there is no new trust decision to
  // make — an administrator granted this person access to this app, and the
  // redirect is allowlisted — so send them straight back. This is what makes the
  // second and third app feel like part of the same product rather than three
  // separate sign-ins.
  //
  // `prompt=login` forces the form anyway, for an app that wants proof of
  // presence before something consequential.
  const session = userSession.read(req);
  if (session && req.query.prompt !== 'login') {
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, session.sub)).limit(1);
    const user = rows[0];
    const access = Array.isArray(user?.appAccess) ? user.appAccess : [];
    if (user && user.isActive && access.includes(app.slug)) {
      const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: String(redirectUri) });
      logAttempt(user.email, app.slug, 'SUCCESS_SSO', req.ip || '');
      const back = new URL(String(redirectUri));
      back.searchParams.set('code', code);
      if (state) back.searchParams.set('state', String(state));
      return res.redirect(back.toString());
    }
    // A stale session — deactivated, or access revoked since. Fall through to the
    // form rather than showing a confusing "no access" dead end.
  }

  res.type('html').send(loginPage({
    appName: app.name,
    appId: app.slug,
    redirectUri: String(redirectUri),
    state: String(state),
    nonce: String(nonce),
    brandColor: app.brandColor || '',
    logoUrl: app.logoUrl || '',
    signedInAs: session?.email || '',
    // Absent rather than broken when the platform has no Google client.
    googleEnabled: await google.configured().catch(() => false)
  }));
});

// Ends the PLATFORM session — the one that lets /authorize skip the sign-in form.
//
// It cannot end an app's session, and nothing here pretends otherwise: the cookie
// is host-only to the auth host, and an app's own session cookie lives on the
// app's own subdomain where this origin cannot reach it. What this does is stop
// the silent re-authentication, so the next app has to ask again.
//
// A real "sign out everywhere" would need each app to clear its own cookie. The
// honest instruction to an app author is: clear yours, then send them here.
router.get('/logout', async (req, res) => {
  userSession.clear(res);
  const back = req.query.redirect_uri;
  // Only back to an app on this platform: the origin must be one some app has
  // registered a redirect URI on. Any other URL made this an open redirect that
  // starts on the auth host, which is what a phishing link wants.
  if (back && await isPlatformOrigin(String(back)).catch(() => false)) return res.redirect(String(back));
  res.type('html').send(errorPage('Signed Out',
    'You have been signed out of Astrodock, so apps will ask who you are again. '
    + 'Any app you are still signed into keeps its own session until you sign out of it.',
  { icon: 'log-out' }));
});

async function isPlatformOrigin(url) {
  let origin;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    origin = u.origin;
  } catch { return false; }
  const rows = await db.select({ uri: schema.appRedirectUris.uri }).from(schema.appRedirectUris);
  return rows.some((r) => {
    try { return new URL(r.uri).origin === origin; } catch { return false; }
  });
}

// ── /login ────────────────────────────────────────────────────────────────────
// Credentials arrive HERE, on the platform's own origin — the app never sees them.
router.post('/login', pageLoginLimiter, express.json(), async (req, res) => {
  const { appId, redirectUri, email, password, totp, recoveryCode, passkeyResponse, handle } = req.body || {};
  const ip = req.ip || '';
  // Signing in to the mobile app rather than to one app. Checked as strictly as
  // an app's redirect: the challenge has to be one /mobile/authorize would take.
  const mobileTarget = req.body && req.body.mobile ? req.body.mobile : null;

  try {
    let app = null;
    if (mobileTarget) {
      if (!await mobile.enabled()) return res.status(404).json({ error: 'Not found.' });
      if (!mobile.validChallenge(mobileTarget.codeChallenge)) {
        return res.status(400).json({ error: 'That sign-in request is not valid. Start again from the app.' });
      }
    } else {
      app = await appBySlug(appId);
      if (!app) return res.status(400).json({ error: 'Unknown app.' });
      if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
        return res.status(400).json({ error: 'Redirect URL not allowed.' });
      }
    }
    const logApp = app ? app.slug : 'mobile';

    let user = null;

    if (passkeyResponse) {
      // Passkey: discoverable, so the credential names the user. User verification
      // is required by the ceremony, which makes this two factors on its own.
      user = await passkeys.finishAuthentication({ handle, response: passkeyResponse });
    } else {
      const addr = String(email || '').toLowerCase().trim();
      const rows = await db.select().from(schema.users).where(eq(schema.users.email, addr)).limit(1);
      const candidate = rows[0];
      // Uniform failure: never reveal whether the account exists, is inactive, or
      // simply has no password set.
      if (!candidate || !candidate.isActive || !await factors.checkPassword(candidate, password)) {
        logAttempt(addr, logApp, 'BAD_PASSWORD', ip);
        return res.status(401).json({ error: 'Those details are not right.' });
      }

      const f = await factors.factorsFor(candidate.id);
      if (f.totp) {
        if (!totp && !recoveryCode) {
          return res.status(401).json({ error: 'Enter the code from your authenticator app.', code: 'totp_required' });
        }
        const ok = recoveryCode
          ? await factors.consumeRecoveryCode(candidate.id, recoveryCode)
          : await factors.checkTotp(candidate, totp);
        if (!ok) {
          logAttempt(addr, logApp, 'BAD_2FA', ip);
          return res.status(401).json({ error: 'That code is not right.', code: 'totp_required' });
        }
      }
      user = candidate;
    }

    // The mobile app is not an app with access of its own: it lists whichever
    // apps the person has, which may be none, plus the dashboard for an operator.
    if (mobileTarget) {
      if (!user.isActive) return res.status(401).json({ error: 'Those details are not right.' });
      userSession.set(res, user);
      const redirect = await finishMobile(user, mobileTarget, ip);
      return res.json({ redirect });
    }

    // Access is a separate question from identity, and stays that way: an operator
    // with no app_access cannot sign into an app.
    const access = Array.isArray(user.appAccess) ? user.appAccess : [];
    if (!access.includes(app.slug)) {
      logAttempt(user.email, app.slug, 'NO_ACCESS', ip);
      return res.status(403).json({ error: 'You do not have access to this app.' });
    }

    // From here on, other apps on this platform will not ask again.
    userSession.set(res, user);

    const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri });
    logAttempt(user.email, app.slug, 'SUCCESS', ip);
    res.json({ code });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── Sign in with Google, for end users ────────────────────────────────────────
//
// Same library and the same verification as the dashboard; only the ending
// differs. Here the result is an authorization code for the app that asked,
// which means the app gets Google sign-in without implementing any of it.
//
// The app's redirect_uri is checked against its allowlist BEFORE leaving for
// Google, not after coming back, so a bad one cannot survive the round trip.

router.get('/login/google/start', pageLoginLimiter, async (req, res) => {
  try {
    if (req.query.mobile === '1') {
      if (!await mobile.enabled()) return res.status(404).type('html').send(errorPage('Not Found', 'There is nothing here.'));
      const codeChallenge = String(req.query.code_challenge || '');
      if (!mobile.validChallenge(codeChallenge)) {
        return res.status(400).type('html').send(errorPage('Start Again from the App', 'That sign-in request is not valid.'));
      }
      const { url } = await google.begin({
        redirectUri: googleCallbackUrl(req),
        context: { surface: 'mobile', codeChallenge, state: String(req.query.state || '').slice(0, 512) }
      });
      return res.redirect(url);
    }
    const app = await appBySlug(req.query.app_id);
    if (!app) return res.type('html').send(errorPage('Unknown App', 'That application is not registered here.'));
    const redirectUri = String(req.query.redirect_uri || '');
    if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
      return res.type('html').send(errorPage('Redirect URL Not Allowed',
        'That return address is not registered for this app.'));
    }
    const { url } = await google.begin({
      redirectUri: googleCallbackUrl(req),
      context: { surface: 'app', appId: app.id, appSlug: app.slug, redirectUri, state: String(req.query.state || '') }
    });
    res.redirect(url);
  } catch (err) {
    res.type('html').send(errorPage('Google Sign-In Unavailable', err.message));
  }
});

router.get('/login/google/callback', pageLoginLimiter, async (req, res) => {
  try {
    const identity = await google.complete({ code: req.query.code, state: req.query.state });
    const ctx = identity.context || {};

    // An invite redeemed with Google comes back here rather than to a callback
    // of its own, because one callback URL is registered on the Google client
    // and a second would have to be added by hand on every install.
    if (ctx.surface === 'invite') return completeInvite({ req, res, identity, ctx });

    // Same reason: attaching a Google account from the account page ends here
    // too, and is told apart by its context rather than by its own URL.
    if (ctx.surface === 'link') return completeLink({ req, res, identity, ctx });

    // And the mobile app's sign-in, for the same reason.
    if (ctx.surface === 'mobile') return completeMobile({ req, res, identity, ctx });

    const app = await appBySlug(ctx.appSlug);
    if (!app) return res.type('html').send(errorPage('Unknown App', 'That application is not registered here.'));

    // Back to this app's sign-in form, asking afresh. The redirect was checked
    // against the app's allowlist when this Google round trip started.
    const retry = `/authorize?${new URLSearchParams({ app_id: app.slug, redirect_uri: ctx.redirectUri, state: ctx.state || '', prompt: 'login' })}`;

    const { user, error } = await googleAccounts.resolveEndUser(identity, app);
    if (error) {
      logAttempt(identity.email, app.slug, 'NO_ACCESS', req.ip || '');
      return res.type('html').send(errorPage('Cannot Sign You In', error,
        { action: { href: retry, label: 'Try Another Way' } }));
    }

    // Identity is settled; access is still its own question.
    const access = Array.isArray(user.appAccess) ? user.appAccess : [];
    if (!access.includes(app.slug)) {
      logAttempt(user.email, app.slug, 'NO_ACCESS', req.ip || '');
      return res.type('html').send(errorPage('No Access',
        `Your Google account signed in, but it has not been given access to ${app.name}. Whoever manages ${app.name} can add you.`,
        { icon: 'lock', action: { href: retry, label: 'Use Another Account' } }));
    }

    // An end user with TOTP set up is still asked for it, because Google's
    // token says nothing about whether a second factor was used over there.
    // Rather than build a second challenge page here, those accounts are sent
    // back to the form they already know.
    const f = await factors.factorsFor(user.id);
    if (f.totp) {
      return res.type('html').send(errorPage('Use Your Password',
        'This account has two-step sign-in, so it signs in with its password and code rather than Google.',
        { icon: 'key', action: { href: retry, label: 'Sign In with Your Password' } }));
    }

    userSession.set(res, user);
    const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: ctx.redirectUri });
    logAttempt(user.email, app.slug, 'SUCCESS', req.ip || '');

    const back = new URL(ctx.redirectUri);
    back.searchParams.set('code', code);
    if (ctx.state) back.searchParams.set('state', ctx.state);
    res.redirect(back.toString());
  } catch (err) {
    res.type('html').send(errorPage('Google Sign-In Failed', err.message));
  }
});

// Finish an invite that was redeemed with Google.
//
// The question this answers is "which account did that Google identity turn out
// to be", and the invited placeholder is only one of three answers:
//
//   • the sub is already linked to an account here — use that one
//   • the verified address belongs to an account here — link the sub to it
//   • neither — link the sub to the placeholder the invite created
//
// The first two matter because someone invited as ann@work may well redeem with
// the Google account they actually use. Granting the placeholder in that case
// would leave them with two accounts and access on the wrong one.
async function completeInvite({ req, res, identity, ctx }) {
  const { invite, user: invited, app, error } = await invites.resolve(ctx.inviteToken);
  if (error) return res.status(400).type('html').send(errorPage('That Invite Cannot Be Used', error));

  let target = await googleAccounts.findLinked(identity.sub);
  if (!target) {
    // Unverified at Google is not an identity: anyone can put any address on an
    // account they have not proven they control.
    if (!identity.emailVerified) {
      return res.type('html').send(errorPage('Google Has Not Verified That Address',
        'Verify the address with Google first, or set a password on the invite instead.'));
    }
    const byEmail = await googleAccounts.findByEmail(identity.email);
    const existing = byEmail && byEmail.id !== invited.id ? byEmail : null;
    if (existing && existing.googleSub && existing.googleSub !== identity.sub) {
      return res.type('html').send(errorPage('Already Linked Elsewhere',
        'An account here already uses that address with a different Google account.'));
    }
    // The invited account already signs in some other way. Attaching whatever
    // Google account followed the link would let anyone holding an invite to that
    // address add a way into it, so only the account's own address may link.
    if (!existing && invited.email !== String(identity.email || '').toLowerCase()) {
      const f = await factors.factorsFor(invited.id);
      if (f.password || f.passkeys || invited.googleSub) {
        return res.type('html').send(errorPage('Use the Account You Already Have',
          `This invite is for ${invited.email}, which already has a way to sign in. Sign in with that instead.`));
      }
    }
    target = existing || invited;
    await googleAccounts.link(target.id, identity);
  }

  if (!target.isActive) {
    return res.type('html').send(errorPage('That Account Is Disabled',
      'Ask whoever runs this server to turn it back on.'));
  }

  const signedIn = await invites.redeem({ invite, userId: target.id });
  // The invite made an account that nobody turned out to need. Removed rather
  // than left behind as a second, credential-less copy of the same person.
  if (target.id !== invited.id) await invites.discardPlaceholder(invited.id);

  userSession.set(res, signedIn);
  logAttempt(signedIn.email, app.slug, 'SUCCESS_INVITE', req.ip || '');

  const landing = await invites.landingUrl(invite, app);
  return res.redirect(landing || '/account');
}

// Finish attaching a Google account to the one already signed in.
//
// The session is re-read here rather than trusted from the context that started
// the round trip, so a link cannot be aimed at an account other than the one
// holding the cookie right now.
async function completeLink({ req, res, identity, ctx }) {
  const session = userSession.read(req);
  if (!session || (ctx.userId && session.sub !== ctx.userId)) {
    return res.status(401).type('html').send(errorPage('Sign In First',
      'That sign-in session has ended. Sign in again and retry from your account page.'));
  }
  try {
    await googleAccounts.linkToUser({ userId: session.sub, identity });
  } catch (err) {
    return res.status(400).type('html').send(errorPage('Could Not Attach That Account', err.message));
  }
  logAttempt(identity.email, 'account', 'GOOGLE_LINKED', req.ip || '');
  return res.redirect('/account?linked=1');
}

// The end of every mobile sign-in, whichever way the person proved who they
// are: a PKCE code for the app, and where to send the browser sheet with it.
async function finishMobile(user, target, ip) {
  const code = await mobile.issueCode({ userId: user.id, codeChallenge: target.codeChallenge });
  logAttempt(user.email, 'mobile', 'SUCCESS', ip);
  return mobile.redirectFor(code, target.state ? String(target.state).slice(0, 512) : '');
}

// Finish a mobile sign-in that went through Google. The same rules as an app's:
// an account is never created here (there is no app to opt in), and an account
// with an authenticator code is sent back to the form.
async function completeMobile({ req, res, identity, ctx }) {
  if (!await mobile.enabled()) return res.status(404).type('html').send(errorPage('Not Found', 'There is nothing here.'));
  const retry = `/mobile/authorize?${new URLSearchParams({
    code_challenge: ctx.codeChallenge, code_challenge_method: 'S256',
    state: ctx.state || '', redirect_uri: mobile.REDIRECT_URI, prompt: 'login'
  })}`;
  const { user, error } = await googleAccounts.resolveEndUser(identity, null);
  if (error) {
    logAttempt(identity.email, 'mobile', 'NO_ACCOUNT', req.ip || '');
    return res.type('html').send(errorPage('Cannot Sign You In', error,
      { action: { href: retry, label: 'Try Another Way' } }));
  }
  const f = await factors.factorsFor(user.id);
  if (f.totp) {
    return res.type('html').send(errorPage('Use Your Password',
      'This account has two-step sign-in, so it signs in with its password and code rather than Google.',
      { icon: 'key', action: { href: retry, label: 'Sign In with Your Password' } }));
  }
  userSession.set(res, user);
  return res.redirect(await finishMobile(user, ctx, req.ip || ''));
}

// ── /token ────────────────────────────────────────────────────────────────────
// Server-to-server. The app secret proves the caller is the app, which is why the
// code alone is not enough to impersonate a user.
router.post('/token', express.json(), async (req, res) => {
  const { code, app_id: appId, app_secret: appSecret } = req.body || {};
  try {
    const app = await appBySlug(appId);
    if (!app) return res.status(400).json({ error: 'Unknown app.' });
    if (!appSecret || !safeEqual(decryptSecret(app.appSecret), appSecret)) {
      return res.status(401).json({ error: 'Invalid app secret.' });
    }
    const user = await oauth.redeemCode({ code, appId: app.id, redirectUri: req.body.redirect_uri });
    res.json({ userId: user.id, email: user.email, name: user.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Passkey challenge for the hosted login page.
router.post('/login/passkey/options', pageLoginLimiter, express.json(), async (req, res) => {
  try {
    const handle = `login:${Math.random().toString(36).slice(2)}${Date.now()}`;
    const options = await passkeys.beginAuthentication({ handle });
    res.json({ handle, options });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// `mobile` is { codeChallenge, state } when the mobile app is signing in, in
// place of appId and redirectUri. The form is the same; /login answers with
// where to go next instead of a code for the page to hand back.
function loginPage({ appName, appId, redirectUri, state, nonce, brandColor, logoUrl, signedInAs, googleEnabled, mobile: mobileTarget = null }) {
  const accent = safeColor(brandColor);
  const cfg = scriptJson({ appId, redirectUri, state, nonce, mobile: mobileTarget });
  const googleHref = mobileTarget
    ? `/login/google/start?${new URLSearchParams({ mobile: '1', code_challenge: mobileTarget.codeChallenge, state: mobileTarget.state || '' })}`
    : `/login/google/start?app_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state || '')}`;
  // Two steps on one page. The second (the authenticator code, or a recovery
  // code in its place) appears only when the server says the account has one,
  // and the email and password are held in memory to send with it: /login is
  // stateless, so the code alone proves nothing.
  return shell(`Sign In to ${appName}`, `
${brandMark(logoUrl, appName)}
<div class="heading"><h1 id="title">Sign In to ${esc(appName)}</h1><p class="sub" id="lead" hidden></p></div>
${errorLine()}
<form id="f">
  <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username webauthn" required></div>
  ${passwordField('password', 'Password')}
  <button type="submit" id="go">Sign In</button>
</form>
<form id="f2" hidden>
  <div class="field" id="totpField"><label for="totp">Authenticator Code</label><input id="totp" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>
  <div class="field" id="recoveryField" hidden><label for="recovery">Recovery Code</label><input id="recovery" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxxx-xxxxx"><p class="hint">Each recovery code works once.</p></div>
  <button type="submit" id="go2">Verify</button>
  <div class="split"><button class="quiet" type="button" id="back">Back</button><button class="quiet" type="button" id="swap">Use a Recovery Code</button></div>
</form>
<div class="alt" id="alt">
  <div class="or"><span>or</span></div>
  <button class="secondary" id="pk" type="button">${icon('key')}Sign In with a Passkey</button>
  ${googleEnabled ? googleButton(googleHref) : ''}
</div>
${signedInAs ? `<p class="muted">Signed in as ${esc(signedInAs)}. Sign in again to continue.</p>` : ''}
<script>
const CFG = ${cfg};
const err = document.getElementById('err');
const show = (m) => { err.querySelector('span').textContent = m; err.hidden = false; };
const clear = () => { err.hidden = true; };
const el = (id) => document.getElementById(id);
let creds = null;
let useRecovery = false;
// Who this sign-in is for: an app, or the mobile app.
const target = () => (CFG.mobile ? { mobile: CFG.mobile } : { appId: CFG.appId, redirectUri: CFG.redirectUri });
function handoff(d) {
  if (CFG.mobile) return window.location.assign(d.redirect);
  const u = new URL(CFG.redirectUri);
  u.searchParams.set('code', d.code);
  if (CFG.state) u.searchParams.set('state', CFG.state);
  window.location.assign(u.toString());
}
async function post(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Sign-in failed'); e.code = d.code; throw e; }
  return d;
}
function codeMode(recovery) {
  useRecovery = recovery;
  el('totpField').hidden = recovery;
  el('recoveryField').hidden = !recovery;
  el('swap').textContent = recovery ? 'Use the Authenticator Code' : 'Use a Recovery Code';
  el('lead').textContent = recovery
    ? 'Enter one of the recovery codes you saved when you set up two-step sign-in.'
    : 'Enter the 6-digit code from your authenticator app.';
  el(recovery ? 'recovery' : 'totp').focus();
}
function step(two) {
  el('f').hidden = two; el('alt').hidden = two;
  el('f2').hidden = !two; el('lead').hidden = !two;
  el('title').textContent = two ? 'Two-Step Sign-In' : ${scriptJson(`Sign In to ${appName}`)};
  clear();
  if (two) codeMode(false); else el('password').focus();
}
el('f').addEventListener('submit', async (e) => {
  e.preventDefault(); clear();
  creds = { email: el('email').value, password: el('password').value };
  el('go').disabled = true;
  try {
    const d = await post('/login', { ...target(), ...creds });
    handoff(d);
  } catch (ex) {
    el('go').disabled = false;
    if (ex.code === 'totp_required') step(true); else show(ex.message);
  }
});
el('f2').addEventListener('submit', async (e) => {
  e.preventDefault(); clear();
  const value = el(useRecovery ? 'recovery' : 'totp').value.trim();
  if (!value) return show(useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code.');
  el('go2').disabled = true;
  try {
    const extra = useRecovery ? { recoveryCode: value } : { totp: value };
    const d = await post('/login', { ...target(), ...creds, ...extra });
    handoff(d);
  } catch (ex) {
    el('go2').disabled = false;
    show(ex.message);
    el(useRecovery ? 'recovery' : 'totp').select();
  }
});
el('swap').addEventListener('click', () => { clear(); codeMode(!useRecovery); });
el('back').addEventListener('click', () => step(false));
${REVEAL_JS}
// WebAuthn's browser half is base64url plumbing around navigator.credentials.
// Written out rather than imported: pulling a script from a CDN onto a login page
// would put a third party in the authentication path and break offline installs.
const b64uToBuf = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');

document.getElementById('pk').addEventListener('click', async () => {
  clear();
  try {
    if (!window.PublicKeyCredential) return show('This browser does not support passkeys.');
    const { handle, options } = await post('/login/passkey/options', {});
    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }))
    };
    const cred = await navigator.credentials.get({ publicKey });
    if (!cred) return show('No passkey was selected.');
    const resp = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined
      }
    };
    const d = await post('/login', { ...target(), handle, passkeyResponse: resp });
    handoff(d);
  } catch (ex) { show(ex.message || 'Passkey sign-in failed.'); }
});
</script>`, { accent });
}

module.exports = router;
module.exports._internal = { loginPage, errorPage, scriptJson };
