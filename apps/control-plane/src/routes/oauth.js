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
const config = require('../config');
const { db, schema } = require('../db');
const oauth = require('../lib/oauth');
const factors = require('../lib/auth-factors');
const passkeys = require('../lib/passkeys');
const { decryptSecret } = require('../lib/crypto');
const { emitEvent } = require('../lib/events');

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

  res.type('html').send(loginPage({
    appName: app.name,
    appId: app.slug,
    redirectUri: String(redirectUri),
    state: String(state),
    nonce: String(nonce)
  }));
});

// ── /login ────────────────────────────────────────────────────────────────────
// Credentials arrive HERE, on the platform's own origin — the app never sees them.
router.post('/login', express.json(), async (req, res) => {
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

    const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri });
    logAttempt(user.email, app.slug, 'SUCCESS', ip);
    res.json({ code });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

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
router.post('/login/passkey/options', express.json(), async (req, res) => {
  try {
    const handle = `login:${Math.random().toString(36).slice(2)}${Date.now()}`;
    const options = await passkeys.beginAuthentication({ handle });
    res.json({ handle, options });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── the hosted page ───────────────────────────────────────────────────────────
// Served as one self-contained document rather than the admin SPA: end users have
// no business loading the dashboard bundle, and a login page with no dependencies
// is a login page with a small attack surface.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6fa;color:#1a2233;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #e3e7ef;border-radius:14px;padding:2rem;width:min(92vw,24rem);box-shadow:0 8px 30px rgba(20,30,60,.07)}
h1{font-size:1.15rem;margin:0 0 .3rem}p.sub{margin:0 0 1.4rem;color:#667;font-size:.9rem}
label{display:block;font-size:.8rem;font-weight:600;color:#445;margin:0 0 .3rem}
input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #d5dae5;border-radius:8px;font-size:1rem;margin-bottom:.9rem;background:#fff;color:inherit}
button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#2f6df6;color:#fff;font-weight:650;font-size:.95rem;cursor:pointer}
button.secondary{background:#eef1f7;color:#2a3550;margin-top:.6rem}
.err{background:#fdecec;color:#a12; padding:.6rem .7rem;border-radius:8px;font-size:.86rem;margin-bottom:.9rem;display:none}
.muted{text-align:center;color:#889;font-size:.78rem;margin-top:1.1rem}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.card{background:#161b22;border-color:#30363d}
input{background:#0d1117;border-color:#30363d}button.secondary{background:#21262d;color:#e6edf3}.err{background:#3d1a1a;color:#ffb4b4}}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function errorPage(title, message) {
  return shell(title, `<h1>${esc(title)}</h1><p class="sub">${esc(message)}</p>`);
}

function loginPage({ appName, appId, redirectUri, state, nonce }) {
  const cfg = esc(JSON.stringify({ appId, redirectUri, state, nonce }));
  return shell(`Sign in to ${appName}`, `
<h1>Sign in to ${esc(appName)}</h1>
<p class="sub">Use your ${esc(config.baseDomain || 'Astrodock')} account.</p>
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
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
</script>`);
}

module.exports = router;
module.exports._internal = { loginPage, errorPage };
