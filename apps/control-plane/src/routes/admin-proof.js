'use strict';

// The passkey-or-authenticator proof that approvals ask for (lib/strong-factor).
// Shared by the approval page and the CLI sign-in page, so both offer the same
// two choices in the same order.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const strongFactor = require('../lib/strong-factor');

const router = express.Router();
router.use(requireAdmin);

async function me(req) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.auth.sub)).limit(1);
  if (!user) throw new Error('Account not found');
  return user;
}

router.get('/', async (req, res) => {
  try { res.json(await strongFactor.availableFor(await me(req))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/passkey/options', async (req, res) => {
  try { res.json(await strongFactor.passkeyOptions(await me(req))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
