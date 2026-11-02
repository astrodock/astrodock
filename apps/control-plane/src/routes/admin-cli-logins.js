'use strict';

// The person's side of `astrodock login`: see a pending sign-in, approve it with
// a passkey or authenticator code, or decline it. See lib/cli-login.
//
// People only. Approving mints a key, and keys are a person's to give out, so
// the approver needs tokens:write — owners and admins.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin, permit, callerHasScope } = require('../middleware/auth');
const { reauthLimiter } = require('../middleware/rateLimiter');
const cliLogin = require('../lib/cli-login');
const strongFactor = require('../lib/strong-factor');

const router = express.Router();
router.use(requireAdmin, permit('tokens:write'));

async function load(req, res) {
  const row = await cliLogin.findByUserCode(req.params.code);
  if (!row) {
    res.status(404).json({ error: 'No sign-in with that code. Check the code in your terminal, or start again.' });
    return null;
  }
  return row;
}

router.get('/:code', async (req, res) => {
  try {
    const row = await load(req, res);
    if (!row) return;
    res.json({ login: await cliLogin.describe(row) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:code/approve', reauthLimiter, async (req, res) => {
  try {
    const row = await load(req, res);
    if (!row) return;
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.auth.sub)).limit(1);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    const { kind, slug, passkeyResponse, totp } = req.body || {};
    if (!await strongFactor.verify(user, { passkeyResponse, totp }, `cli:${row.userCode}`)) {
      return res.status(401).json({ error: 'Confirm with your passkey or a code from your authenticator app.', code: 'proof_required' });
    }
    const updated = await cliLogin.approve(row, {
      user, kind, slug, canCreateApps: callerHasScope(req.auth, 'apps:write')
    });
    res.json({ login: await cliLogin.describe(updated) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/:code/deny', async (req, res) => {
  try {
    const row = await load(req, res);
    if (!row) return;
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.auth.sub)).limit(1);
    await cliLogin.deny(row, { user });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
