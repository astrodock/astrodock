'use strict';

// Operator sign-in to the dashboard.
//
// Distinct from app sign-in (routes/oauth.js): this checks `operator_role`, that
// one checks `app_access`. The two are deliberately independent, so an owner with
// no app access still cannot sign into an app, and an end user cannot reach the
// dashboard however they authenticate.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const factors = require('../lib/auth-factors');
const passkeys = require('../lib/passkeys');
const sessions = require('../lib/sessions');
const roles = require('../lib/roles');
const { getSetting } = require('../lib/settings');
const { emitEvent } = require('../lib/events');
// Unauthenticated password guessing: the limiter existed but was never applied here.
const { adminLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function deny(res) {
  // One message for every failure mode — wrong password, no such account,
  // deactivated, not an operator. Anything more specific is an oracle.
  return res.status(401).json({ error: 'Invalid credentials' });
}

async function issue(res, user, req) {
  const { token, session } = await sessions.create(user, {
    ip: req.ip, userAgent: req.headers['user-agent']
  });
  await emitEvent({
    category: 'audit', type: 'operator.signed_in', severity: 'info',
    message: `${user.email} signed in`,
    actorType: 'admin', actor: user.email, targetType: 'user', targetId: user.id, ip: req.ip || ''
  }).catch(() => {});
  return res.json({
    token,
    sessionId: session.id,
    user: { id: user.id, email: user.email, name: user.name, role: user.operatorRole }
  });
}

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password, totp, recoveryCode } = req.body || {};
  try {
    const addr = String(email || '').toLowerCase().trim();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, addr)).limit(1);

    if (!user || !user.isActive || !roles.isOperator(user)) return deny(res);
    if (!await factors.checkPassword(user, password)) return deny(res);

    const f = await factors.factorsFor(user.id);

    // An owner can require every operator to hold a second factor. Existing
    // operators are not locked out — they are told to enrol, which is why this
    // returns a distinguishable code rather than a flat refusal.
    // The setting is an enum ('on'/'off'), not a boolean — and 'off' is a truthy
    // string, so this must compare rather than test for truthiness.
    const mfaRequired = (await getSetting('security.require_mfa', 'off')) === 'on';
    if (mfaRequired && !factors.hasSecondFactor(f)) {
      return res.status(403).json({
        error: 'This platform requires two-factor authentication. Set it up to continue.',
        code: 'mfa_enrolment_required'
      });
    }

    if (f.totp) {
      if (!totp && !recoveryCode) {
        return res.status(401).json({ error: 'Enter the code from your authenticator app.', code: 'totp_required' });
      }
      const ok = recoveryCode
        ? await factors.consumeRecoveryCode(user.id, recoveryCode)
        : await factors.checkTotp(user, totp);
      if (!ok) return res.status(401).json({ error: 'That code is not right.', code: 'totp_required' });
    }

    return issue(res, user, req);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── passkey sign-in ───────────────────────────────────────────────────────────
// Discoverable credentials, so there is no username step: the authenticator says
// who it is, and user verification means it also proved the person is present.

router.post('/login/passkey/options', adminLoginLimiter, async (req, res) => {
  try {
    const handle = `op:${Math.random().toString(36).slice(2)}${Date.now()}`;
    res.json({ handle, options: await passkeys.beginAuthentication({ handle }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login/passkey', adminLoginLimiter, async (req, res) => {
  try {
    const { handle, response } = req.body || {};
    const user = await passkeys.finishAuthentication({ handle, response });
    if (!roles.isOperator(user)) return deny(res);
    return issue(res, user, req);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
