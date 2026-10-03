'use strict';

// Public hosted-login endpoints. Mounted at the root, not under /admin, because
// end users reach these — they are the sign-in surface for deployed apps.
//
//   GET  /authorize   browser lands here from the app; we authenticate and bounce back
//   POST /login       the hosted login page submits here (password, or passkey)
//   POST /token       the app's SERVER exchanges the code, with its app secret

const express = require('express');
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

// Registered once on the Google client and shared by every app: the app being
// signed into travels in the sign-in's own context, not in the redirect URI.
function googleCallbackUrl(req) {
  const scheme = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${scheme}://${req.get('host')}/login/google/callback`;
}
const { decryptSecret } = require('../lib/crypto');
// The page shell, shared with the invite redemption page: the same surface at
// two moments, so one stylesheet.
const { esc, scriptJson, safeColor, shell, errorPage, brandMark, googleButton } = require('../lib/auth-pages');
const { emitEvent } = require('../lib/events');
// The hosted sign-in is the replacement for /verify, which was rate limited.
// This one was not — same exposure, no throttle.
const { pageLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function logAttempt(email, appId, result, ip) {
  db.insert(schema.authLogs).values({ email: email || '', appId: appId || '', result, ip: ip || '' }).catch(() => {});
}

async function appBySlug(slug) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, String(slug || ''))).limit(1);
  return rows[0] || null;
}

// ── /authorize ────────────────────────────────────────────────────────────────
// Validates the request, then serves the hosted login page. Everything the page
// needs is embedded server-side; nothing sensitive is in the query string.
router.get('/authorize', async (req, res) => {
  const { app_id: appId, redirect_uri: redirectUri, state = '', nonce = '' } = req.query;

  const app = await appBySlug(appId);
  if (!app) return res.status(400).type('html').send(errorPage('Unknown app', 'That application is not registered on this server.'));

  // Validate the redirect BEFORE anything else can bounce a user to it.
  if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
    return res.status(400).type('html').send(errorPage(
      'Redirect URL not allowed',
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
router.get('/logout', (req, res) => {
  userSession.clear(res);
  const back = req.query.redirect_uri;
  if (back && /^https?:\/\//.test(String(back))) return res.redirect(String(back));
  res.type('html').send(errorPage('Signed out',
    'You have been signed out of Astrodock, so apps will ask who you are again. '
    + 'Any app you are still signed into keeps its own session until you sign out of it.'));
});

// ── /login ────────────────────────────────────────────────────────────────────
// Credentials arrive HERE, on the platform's own origin — the app never sees them.
router.post('/login', pageLoginLimiter, express.json(), async (req, res) => {
  const { appId, redirectUri, email, password, totp, recoveryCode, passkeyResponse, handle } = req.body || {};
  const ip = req.ip || '';

  try {
    const app = await appBySlug(appId);
    if (!app) return res.status(400).json({ error: 'Unknown app.' });
    if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
      return res.status(400).json({ error: 'Redirect URL not allowed.' });
    }

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
        logAttempt(addr, app.slug, 'BAD_PASSWORD', ip);
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
          logAttempt(addr, app.slug, 'BAD_2FA', ip);
          return res.status(401).json({ error: 'That code is not right.', code: 'totp_required' });
        }
      }
      user = candidate;
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
    const app = await appBySlug(req.query.app_id);
    if (!app) return res.type('html').send(errorPage('Unknown app', 'That application is not registered here.'));
    const redirectUri = String(req.query.redirect_uri || '');
    if (!await oauth.isAllowedRedirect(app.id, redirectUri)) {
      return res.type('html').send(errorPage('Redirect URL not allowed',
        'That return address is not registered for this app.'));
    }
    const { url } = await google.begin({
      redirectUri: googleCallbackUrl(req),
      context: { surface: 'app', appId: app.id, appSlug: app.slug, redirectUri, state: String(req.query.state || '') }
    });
    res.redirect(url);
  } catch (err) {
    res.type('html').send(errorPage('Google sign-in unavailable', err.message));
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

    const app = await appBySlug(ctx.appSlug);
    if (!app) return res.type('html').send(errorPage('Unknown app', 'That application is not registered here.'));

    const { user, error } = await googleAccounts.resolveEndUser(identity, app);
    if (error) {
      logAttempt(identity.email, app.slug, 'NO_ACCESS', req.ip || '');
      return res.type('html').send(errorPage('Cannot sign you in', error));
    }

    // Identity is settled; access is still its own question.
    const access = Array.isArray(user.appAccess) ? user.appAccess : [];
    if (!access.includes(app.slug)) {
      logAttempt(user.email, app.slug, 'NO_ACCESS', req.ip || '');
      return res.type('html').send(errorPage('No access',
        'Your Google account signed in, but it has not been given access to this app.'));
    }

    // An end user with TOTP set up is still asked for it, because Google's
    // token says nothing about whether a second factor was used over there.
    // Rather than build a second challenge page here, those accounts are sent
    // back to the form they already know.
    const f = await factors.factorsFor(user.id);
    if (f.totp) {
      return res.type('html').send(errorPage('Use your password',
        'This account has two-factor authentication, so it signs in with its password and code rather than Google.'));
    }

    userSession.set(res, user);
    const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: ctx.redirectUri });
    logAttempt(user.email, app.slug, 'SUCCESS', req.ip || '');

    const back = new URL(ctx.redirectUri);
    back.searchParams.set('code', code);
    if (ctx.state) back.searchParams.set('state', ctx.state);
    res.redirect(back.toString());
  } catch (err) {
    res.type('html').send(errorPage('Google sign-in failed', err.message));
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
  if (error) return res.status(400).type('html').send(errorPage('That invite cannot be used', error));

  let target = await googleAccounts.findLinked(identity.sub);
  if (!target) {
    // Unverified at Google is not an identity: anyone can put any address on an
    // account they have not proven they control.
    if (!identity.emailVerified) {
      return res.type('html').send(errorPage('Google has not verified that address',
        'Verify the address with Google first, or set a password on the invite instead.'));
    }
    const byEmail = await googleAccounts.findByEmail(identity.email);
    const existing = byEmail && byEmail.id !== invited.id ? byEmail : null;
    if (existing && existing.googleSub && existing.googleSub !== identity.sub) {
      return res.type('html').send(errorPage('Already linked elsewhere',
        'An account here already uses that address with a different Google account.'));
    }
    target = existing || invited;
    await googleAccounts.link(target.id, identity);
  }

  if (!target.isActive) {
    return res.type('html').send(errorPage('That account is disabled',
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
    return res.status(401).type('html').send(errorPage('Sign in first',
      'That sign-in session has ended. Sign in again and retry from your account page.'));
  }
  try {
    await googleAccounts.linkToUser({ userId: session.sub, identity });
  } catch (err) {
    return res.status(400).type('html').send(errorPage('Could not attach that account', err.message));
  }
  logAttempt(identity.email, 'account', 'GOOGLE_LINKED', req.ip || '');
  return res.redirect('/account?linked=1');
}

// ── /token ────────────────────────────────────────────────────────────────────
// Server-to-server. The app secret proves the caller is the app, which is why the
// code alone is not enough to impersonate a user.
router.post('/token', express.json(), async (req, res) => {
  const { code, app_id: appId, app_secret: appSecret } = req.body || {};
  try {
    const app = await appBySlug(appId);
    if (!app) return res.status(400).json({ error: 'Unknown app.' });
    if (!appSecret || decryptSecret(app.appSecret) !== appSecret) {
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

function loginPage({ appName, appId, redirectUri, state, nonce, brandColor, logoUrl, signedInAs, googleEnabled }) {
  const accent = safeColor(brandColor);
  const cfg = scriptJson({ appId, redirectUri, state, nonce });
  return shell(`Sign in to ${appName}`, `
${brandMark(logoUrl, appName)}
<h1 class="solo">Sign in to ${esc(appName)}</h1>
<div class="err" id="err"></div>
<form id="f">
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="username webauthn" required>
  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="current-password">
  <div id="totpWrap" style="display:none">
    <label for="totp">Authenticator code</label>
    <input id="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
  </div>
  <button type="submit" id="go">Sign in</button>
</form>
<button class="secondary" id="pk" type="button">Sign in with a passkey</button>
${googleEnabled ? googleButton(`/login/google/start?app_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state || '')}`) : ''}
${signedInAs ? `<p class="muted">Signed in as ${esc(signedInAs)} — sign in again to continue.</p>` : ''}
<p class="muted">Protected by Astrodock</p>
<script>
const CFG = ${cfg};
const err = document.getElementById('err');
const show = (m) => { err.textContent = m; err.style.display = 'block'; };
function handoff(code) {
  const u = new URL(CFG.redirectUri);
  u.searchParams.set('code', code);
  if (CFG.state) u.searchParams.set('state', CFG.state);
  window.location.assign(u.toString());
}
async function post(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Sign-in failed'); e.code = d.code; throw e; }
  return d;
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault(); err.style.display='none';
  try {
    const d = await post('/login', {
      appId: CFG.appId, redirectUri: CFG.redirectUri,
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
      totp: document.getElementById('totp').value || undefined
    });
    handoff(d.code);
  } catch (ex) {
    if (ex.code === 'totp_required') document.getElementById('totpWrap').style.display = 'block';
    show(ex.message);
  }
});
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
  err.style.display='none';
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
    const d = await post('/login', { appId: CFG.appId, redirectUri: CFG.redirectUri, handle, passkeyResponse: resp });
    handoff(d.code);
  } catch (ex) { show(ex.message || 'Passkey sign-in failed.'); }
});
</script>`, { accent });
}

module.exports = router;
module.exports._internal = { loginPage, errorPage, scriptJson };
