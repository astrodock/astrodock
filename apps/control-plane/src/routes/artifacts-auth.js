'use strict';

// Signing in to an artifact, on the auth host (auth.<base-domain>/artifacts/*).
//
// The artifact's own host sends people here (/_astrodock/signin). Then:
//   - someone on the account, already signed in to the platform and with access,
//     goes straight back with a one-time grant, no prompt;
//   - anyone else enters their email, gets a 6-digit code, and enters it.
// The code works for this artifact only, and does not sign anyone in to the
// platform, so each artifact asks a guest once per device.
//
// Server-rendered forms, no script. The responses do not say whether an address
// has access: "if it has access, a code is on its way" either way.

const express = require('express');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const A = require('../lib/artifacts/access');
const userSession = require('../lib/user-session');
const emailConfig = require('../lib/email-config');
const { sendEmail } = require('../lib/email');
const { shell, errorPage, esc, brandMark, icon } = require('../lib/auth-pages');
const { pageLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '8kb' }));

function safeNext(n) {
  const s = String(n || '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

function callbackUrl(artifact, code, next) {
  const url = new URL(`${config.artifactOrigin(artifact.publicId)}/_astrodock/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('next', safeNext(next));
  return url.toString();
}

async function load(req, res) {
  const publicId = String(req.query.a || req.body?.a || '');
  const artifact = /^[a-z0-9]{12}$/.test(publicId) ? await A.loadArtifact(publicId) : null;
  if (!artifact || !artifact.isActive || artifact.suspendedAt) {
    res.status(404).type('html').send(errorPage('Not Found', 'This artifact does not exist or is no longer available.'));
    return null;
  }
  return artifact;
}

/** Does this address have access, before there is necessarily an account for it? */
async function emailHasAccess(artifact, email) {
  if (await A.shareFor(artifact.id, email)) return true;
  if (!artifact.ownerId) return false;
  const [o] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId)).limit(1);
  return !!o && A.normEmail(o.email) === A.normEmail(email);
}

const hidden = (artifact, next, email) => `<input type="hidden" name="a" value="${esc(artifact.publicId)}">
<input type="hidden" name="next" value="${esc(safeNext(next))}">${email ? `<input type="hidden" name="email" value="${esc(email)}">` : ''}`;

function emailPage(artifact, { next, email = '', error = '' } = {}) {
  return shell(`Sign In · ${artifact.title || 'Artifact'}`, `${brandMark('', '')}
<div class="heading"><h1>${esc(artifact.title || 'Untitled')}</h1>
<p class="sub">Enter your email address. We will send you a 6-digit code to sign in.</p></div>
${error ? `<div class="err" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
<form method="post" action="/artifacts/signin/code">
${hidden(artifact, next)}
<div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" autofocus></div>
<button type="submit">Send Code</button>
</form>`);
}

function codePage(artifact, { next, email, error = '' }) {
  return shell(`Enter Code · ${artifact.title || 'Artifact'}`, `${brandMark('', '')}
<div class="heading"><h1>Check Your Email</h1>
<p class="sub">If <b>${esc(email)}</b> has access to ${esc(artifact.title || 'this artifact')}, a 6-digit code is on its way. It expires in 10 minutes.</p></div>
${error ? `<div class="err" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
<form method="post" action="/artifacts/signin/verify">
${hidden(artifact, next, email)}
<div class="field"><label for="code">Code</label>
<input id="code" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></div>
<button type="submit">Sign In</button>
</form>
<form method="get" action="/artifacts/signin">
<input type="hidden" name="a" value="${esc(artifact.publicId)}"><input type="hidden" name="next" value="${esc(safeNext(next))}">
<button type="submit" class="secondary">Use a Different Email</button>
</form>`);
}

// Start: account members with a platform session go straight through.
router.get('/signin', async (req, res, next) => {
  try {
    const artifact = await load(req, res);
    if (!artifact) return;
    res.set('Cache-Control', 'no-store');
    const sess = userSession.read(req);
    if (sess) {
      const user = await A.loadUser(sess.sub);
      if (user && A.isAccountMember(user) && await A.hasAccess(artifact, user)) {
        const code = await A.issueGrant(artifact, user);
        return res.redirect(callbackUrl(artifact, code, req.query.next));
      }
    }
    res.type('html').send(emailPage(artifact, { next: req.query.next, email: String(req.query.email || '').slice(0, 254) }));
  } catch (err) { next(err); }
});

router.post('/signin/code', pageLoginLimiter, async (req, res, next) => {
  try {
    const artifact = await load(req, res);
    if (!artifact) return;
    res.set('Cache-Control', 'no-store');
    const email = A.normEmail(req.body.email);
    if (!A.validEmail(email)) {
      return res.status(400).type('html').send(emailPage(artifact, { next: req.body.next, email, error: 'Enter a valid email address.' }));
    }
    if (!emailConfig.isUsable(await emailConfig.resolve())) {
      return res.status(503).type('html').send(emailPage(artifact, { next: req.body.next, email, error: 'This server cannot send email yet. Ask the person who shared this with you.' }));
    }
    if (await emailHasAccess(artifact, email) && await A.recentCodeCount(email) < config.artifacts.codesPerHour) {
      const code = await A.createCode(artifact, email, req.ip);
      const title = artifact.title || 'an artifact';
      sendEmail({
        to: email,
        subject: `${code} is your sign-in code for ${title}`,
        html: `<div style="font:14px/1.5 -apple-system,'Segoe UI',sans-serif;max-width:480px">
<p style="margin:0 0 12px;color:#3f3f46">Your code to sign in to ${esc(title)}:</p>
<p style="margin:0 0 16px;font-size:28px;font-weight:600;letter-spacing:.2em;color:#09090b">${code}</p>
<p style="margin:0;color:#71717a;font-size:13px">It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p></div>`
      }).then(() => db.insert(schema.artifactSends).values({ artifactId: artifact.id, ownerId: artifact.ownerId, kind: 'code', recipient: email }))
        .catch((err) => console.error('[artifacts] code email failed:', err.message));
    }
    res.type('html').send(codePage(artifact, { next: req.body.next, email }));
  } catch (err) { next(err); }
});

router.post('/signin/verify', pageLoginLimiter, async (req, res, next) => {
  try {
    const artifact = await load(req, res);
    if (!artifact) return;
    res.set('Cache-Control', 'no-store');
    const email = A.normEmail(req.body.email);
    const ok = A.validEmail(email) && await A.checkCode(artifact, email, req.body.code);
    // Access is checked again: a share removed after the code was sent wins.
    if (!ok || !(await emailHasAccess(artifact, email))) {
      return res.status(401).type('html').send(codePage(artifact, { next: req.body.next, email, error: 'That code is not right, or it has expired.' }));
    }
    const user = await A.userForEmail(email);
    if (!user) {
      return res.status(403).type('html').send(errorPage('Account Unavailable', 'This account has been turned off.'));
    }
    db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id)).catch(() => {});
    const code = await A.issueGrant(artifact, user);
    res.redirect(callbackUrl(artifact, code, req.body.next));
  } catch (err) { next(err); }
});

module.exports = router;
