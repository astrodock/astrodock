'use strict';

// Redeeming an invite: the first thing a new end user ever sees of this
// platform, and the only page that exists before they have a credential.
//
// It is deliberately the same surface as the sign-in page, branded with the
// app's own name and logo, because the point is that someone invited to Valise
// should feel like they are signing up for Valise. What they are told is who
// invited them and to what; what they are not told is anything about the box
// it runs on.
//
//   GET  /invite/:token                  the page
//   GET  /invite/:token/google           leave for Google, come back signed in
//   POST /invite/:token/password         set a password instead
//
// The Google round trip ends at /login/google/callback, which every other
// Google sign-in here also uses — one callback URL is registered on the Google
// client, so a second one would have to be registered by hand on every install.
// The callback tells the two apart by the context it carries.

const express = require('express');
const invites = require('../lib/invites');
const google = require('../lib/google');
const factors = require('../lib/auth-factors');
const userSession = require('../lib/user-session');
const { esc, scriptJson, safeColor, shell, errorPage, brandMark, googleButton } = require('../lib/auth-pages');
const { pageLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ── the page ──────────────────────────────────────────────────────────────────

function invitePage({ appName, appId, token, brandColor, logoUrl, invitedByName, email, googleEnabled, needsCredential }) {
  const accent = safeColor(brandColor);
  const cfg = scriptJson({ token });
  const who = invitedByName ? `${invitedByName} invited you to ${appName}.` : `You have been invited to ${appName}.`;

  return shell(`Join ${appName}`, `
${brandMark(logoUrl, appName)}
<h1>Join ${esc(appName)}</h1>
<p class="sub">${esc(who)}</p>
<div class="err" id="err"></div>
<p class="who">Setting up <strong>${esc(email)}</strong></p>
${googleEnabled ? googleButton(`/invite/${encodeURIComponent(token)}/google`, 'Continue with Google') : ''}
${needsCredential ? `
${googleEnabled ? '<div class="or"><span>or set a password</span></div>' : ''}
<form id="f">
  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="new-password" minlength="8" required>
  <label for="confirm">Confirm password</label>
  <input id="confirm" type="password" autocomplete="new-password" minlength="8" required>
  <button type="submit" id="go">Create my account</button>
</form>` : `
<p class="muted">You already have an account here, so there is nothing to set up.</p>`}
<p class="muted">Protected by Astrodock</p>
<script>
const CFG = ${cfg};
const err = document.getElementById('err');
const show = (m) => { err.textContent = m; err.style.display = 'block'; };
const form = document.getElementById('f');
if (form) form.addEventListener('submit', async (e) => {
  e.preventDefault(); err.style.display = 'none';
  const pw = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  // Checked here as well as on the server, because a mismatch is a typo and a
  // typo deserves an answer without a round trip.
  if (pw !== confirm) return show('Those two passwords are not the same.');
  const go = document.getElementById('go');
  go.disabled = true;
  try {
    const r = await fetch('/invite/' + encodeURIComponent(CFG.token) + '/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'That did not work.');
    window.location.assign(d.redirect);
  } catch (ex) {
    go.disabled = false;
    show(ex.message);
  }
});
</script>`, { accent });
}

/** Whether this account can already sign in, or is starting from nothing. */
async function hasCredential(user) {
  const f = await factors.factorsFor(user.id);
  return !!(f.password || f.passkeys || user.googleSub);
}

router.get('/:token', pageLoginLimiter, async (req, res) => {
  const { invite, user, app, error } = await invites.resolve(req.params.token);
  if (error) return res.status(400).type('html').send(errorPage('That invite cannot be used', error));

  res.type('html').send(invitePage({
    appName: app.name,
    appId: app.slug,
    token: req.params.token,
    brandColor: app.brandColor || '',
    logoUrl: app.logoUrl || '',
    invitedByName: invite.invitedByName || '',
    email: user.email,
    googleEnabled: await google.configured().catch(() => false),
    needsCredential: !await hasCredential(user)
  }));
});

// ── setting a password ────────────────────────────────────────────────────────

router.post('/:token/password', pageLoginLimiter, express.json(), async (req, res) => {
  const { invite, user, app, error } = await invites.resolve(req.params.token);
  if (error) return res.status(400).json({ error });

  try {
    await factors.setPassword(user.id, req.body?.password);
    const signedIn = await invites.redeem({ invite, userId: user.id });
    userSession.set(res, signedIn);
    const redirect = await invites.landingUrl(invite, app);
    res.json({ redirect: redirect || '/account' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── or bringing a Google account ──────────────────────────────────────────────

// Registered once on the Google client and shared by every sign-in here, so the
// app or invite being redeemed travels in the round trip's context rather than
// in the redirect URI.
function googleCallbackUrl(req) {
  const scheme = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${scheme}://${req.get('host')}/login/google/callback`;
}

router.get('/:token/google', pageLoginLimiter, async (req, res) => {
  const { app, error } = await invites.resolve(req.params.token);
  if (error) return res.status(400).type('html').send(errorPage('That invite cannot be used', error));
  try {
    const { url } = await google.begin({
      redirectUri: googleCallbackUrl(req),
      context: { surface: 'invite', inviteToken: req.params.token, appSlug: app.slug }
    });
    res.redirect(url);
  } catch (err) {
    res.type('html').send(errorPage('Google sign-in unavailable', err.message));
  }
});

module.exports = router;
module.exports._internal = { invitePage };
