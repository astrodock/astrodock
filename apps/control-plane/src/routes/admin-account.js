'use strict';

// Your own account: factors, sessions, recovery codes.
//
// Everything here acts on the SIGNED-IN user only — never on someone else, which
// is what separates it from admin-users. Changing how you sign in is guarded by
// step-up re-auth, because a walked-away laptop should not be enough to swap
// somebody's credentials for your own.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const sessions = require('../lib/sessions');
const factors = require('../lib/auth-factors');
const passkeys = require('../lib/passkeys');
const { emitEvent } = require('../lib/events');

const router = express.Router();
router.use(requireAdmin);

async function me(req) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.auth.sub)).limit(1);
  if (!user) throw new Error('Account not found');
  return user;
}

const audit = (req, type, message) => emitEvent({
  category: 'audit', type, severity: 'info', message,
  actorType: 'admin', actor: req.auth.email, targetType: 'user', targetId: req.auth.sub, ip: req.ip || ''
}).catch(() => {});

// ── overview ──────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = await me(req);
    const f = await factors.factorsFor(user.id);
    const active = await sessions.listFor(user.id);
    res.json({
      email: user.email,
      name: user.name,
      role: user.operatorRole,
      lastLoginAt: user.lastLoginAt,
      factors: {
        password: f.password,
        totp: f.totp,
        passwordless: f.passwordless,
        recoveryCodesRemaining: f.recoveryCodesRemaining,
        passkeys: f.passkeyList.map((c) => ({
          id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt,
          // A credential enrolled against a previous domain no longer works.
          stale: c.rpId && c.rpId !== passkeys.rpId()
        }))
      },
      // Enough to spot a session you do not recognise.
      sessions: active.map((s) => ({
        id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt, current: s.id === req.auth.sessionId
      })),
      reauthFresh: sessions.reauthIsFresh(req.auth.reauthAt)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── step-up ───────────────────────────────────────────────────────────────────
// Prove it is still you, without signing out and back in.
router.post('/reauth', async (req, res) => {
  try {
    const user = await me(req);
    const { password, totp } = req.body || {};
    const ok = password ? await factors.checkPassword(user, password)
      : (totp ? await factors.checkTotp(user, totp) : false);
    if (!ok) return res.status(401).json({ error: 'That did not match.' });
    if (req.auth.sessionId) await sessions.markReauth(req.auth.sessionId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── password ──────────────────────────────────────────────────────────────────
router.put('/password', sessions.requireRecentAuth, async (req, res) => {
  try {
    await factors.setPassword(req.auth.sub, (req.body || {}).password);
    await audit(req, 'account.password_changed', `${req.auth.email} changed their password`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Going passwordless. Refused unless a passkey exists — see auth-factors.
router.delete('/password', sessions.requireRecentAuth, async (req, res) => {
  try {
    await factors.removePassword(req.auth.sub);
    await audit(req, 'account.password_removed', `${req.auth.email} switched to passkey-only sign-in`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── passkeys ──────────────────────────────────────────────────────────────────
router.post('/passkeys/options', sessions.requireRecentAuth, async (req, res) => {
  try { res.json(await passkeys.beginRegistration(await me(req))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/passkeys', sessions.requireRecentAuth, async (req, res) => {
  try {
    const user = await me(req);
    const { response, label } = req.body || {};
    const out = await passkeys.finishRegistration(user, response, label);
    await audit(req, 'account.passkey_added', `${user.email} added a passkey${label ? ` (${label})` : ''}`);
    res.status(201).json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/passkeys/:id', sessions.requireRecentAuth, async (req, res) => {
  try {
    // Refuses if this is the only way in — see auth-factors.assertStillReachable.
    await factors.assertStillReachable(req.auth.sub, 'removePasskey');
    await passkeys.remove(req.auth.sub, req.params.id);
    await audit(req, 'account.passkey_removed', `${req.auth.email} removed a passkey`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── TOTP ──────────────────────────────────────────────────────────────────────
router.post('/totp/begin', sessions.requireRecentAuth, async (req, res) => {
  try {
    const user = await me(req);
    // The secret is returned once, here, so it can be shown as a QR / typed in.
    res.json(await factors.beginTotp(user.id, user.email));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/totp/confirm', sessions.requireRecentAuth, async (req, res) => {
  try {
    await factors.confirmTotp(req.auth.sub, (req.body || {}).code);
    await audit(req, 'account.totp_enabled', `${req.auth.email} enabled an authenticator app`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/totp', sessions.requireRecentAuth, async (req, res) => {
  try {
    await factors.removeTotp(req.auth.sub);
    await audit(req, 'account.totp_disabled', `${req.auth.email} removed their authenticator app`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── recovery codes ────────────────────────────────────────────────────────────
router.post('/recovery-codes', sessions.requireRecentAuth, async (req, res) => {
  try {
    const codes = await factors.generateRecoveryCodes(req.auth.sub);
    await audit(req, 'account.recovery_codes_generated', `${req.auth.email} generated new recovery codes`);
    // Shown once. Regenerating invalidates the previous set.
    res.json({ codes });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── sessions ──────────────────────────────────────────────────────────────────
router.delete('/sessions/:id', async (req, res) => {
  try {
    const mine = await sessions.listFor(req.auth.sub);
    if (!mine.some((s) => s.id === req.params.id)) return res.status(404).json({ error: 'Session not found' });
    await sessions.revoke(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/sessions/revoke-others', async (req, res) => {
  try {
    const n = await sessions.revokeAllFor(req.auth.sub, { except: req.auth.sessionId });
    await audit(req, 'account.sessions_revoked', `${req.auth.email} signed out ${n} other session(s)`);
    res.json({ ok: true, revoked: n });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
