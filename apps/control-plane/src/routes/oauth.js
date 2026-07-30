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
router.post('/login/passkey/options', pageLoginLimiter, express.json(), async (req, res) => {
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
/* This page is the only Astrodock surface an app's end users ever see, and it
   used to be a generic blue form — GitHub-ish greys and #2f6df6 — sharing no
   colour, radius or type with the dashboard. Same tokens as the admin theme
   now, both schemes. Kept self-contained: no webfont, no stylesheet request,
   because it renders on an app's own domain before anything else loads. */
:root{
  color-scheme:light dark;
  --bg:#f4f6fa; --surface:#fff; --line:#dce2ec; --field:#f4f7fb;
  --text:#121823; --text-2:#445064; --text-3:#626e7d;
  --accent:#0b7c56; --accent-ink:#fff;
  --danger:#d12536; --danger-bg:rgba(209,37,54,.10);
  --r:14px; --r-sm:9px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0a0e15; --surface:#0f141d; --line:#222d3b; --field:#0c121b;
  --text:#f1f5fa; --text-2:#b6c4d4; --text-3:#8595a8;
  --accent:#2fe6a8; --accent-ink:#06120d;
  --danger:#ff6573; --danger-bg:rgba(255,101,115,.13);
}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);
  display:grid;place-items:center;min-height:100vh;margin:0;line-height:1.55;letter-spacing:.1px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:2.1rem;
  width:min(92vw,24rem);box-shadow:0 14px 40px rgba(20,30,60,.09)}
.mark{display:block;margin:0 auto .9rem}
h1{font-size:1.2rem;font-weight:650;letter-spacing:-.3px;margin:0 0 .3rem;text-align:center}
p.sub{margin:0 0 1.5rem;color:var(--text-3);font-size:.88rem;text-align:center}
label{display:block;font-size:.79rem;font-weight:600;color:var(--text-2);margin:0 0 .35rem}
input{width:100%;padding:.62rem .72rem;border:1px solid var(--line);border-radius:var(--r-sm);
  font-size:1rem;font-family:inherit;margin-bottom:.9rem;background:var(--field);color:inherit;
  outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
button{width:100%;padding:.72rem;border:0;border-radius:var(--r-sm);background:var(--accent);
  color:var(--accent-ink);font-family:inherit;font-weight:650;font-size:.95rem;cursor:pointer;
  transition:filter .15s}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.6;cursor:default}
button.secondary{background:transparent;border:1px solid var(--line);color:var(--text-2);margin-top:.6rem}
button.secondary:hover{border-color:var(--accent);color:var(--accent);filter:none}
.err{background:var(--danger-bg);color:var(--danger);padding:.62rem .72rem;border-radius:var(--r-sm);
  font-size:.86rem;margin-bottom:.9rem;display:none}
.muted{text-align:center;color:var(--text-3);font-size:.76rem;margin-top:1.2rem}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function errorPage(title, message) {
  return shell(title, `<h1>${esc(title)}</h1><p class="sub">${esc(message)}</p>`);
}

function loginPage({ appName, appId, redirectUri, state, nonce }) {
  const cfg = esc(JSON.stringify({ appId, redirectUri, state, nonce }));
  return shell(`Sign in to ${appName}`, `
<svg class="mark" width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
  <circle cx="17" cy="17" r="15" stroke="var(--accent)" stroke-width="1.4" opacity=".4"/>
  <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" stroke-width="1.4" opacity=".7"/>
  <circle cx="17" cy="17" r="3.6" fill="var(--accent)"/>
  <circle cx="32" cy="17" r="2.3" fill="var(--text-3)"/>
</svg>
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
