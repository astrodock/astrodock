'use strict';

// Approvals for what an access key asked to do beyond one app. See lib/approvals.
//
// A key may read its own approvals: that is how the CLI waits for a person. Only
// a person decides, and approving needs a passkey or authenticator code on every
// decision (lib/strong-factor), not a recent sign-in.

const express = require('express');
const { and, or, eq, ne, lte, desc, gt, inArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const { resolveAuth, callerHasScope, welcomeRefused } = require('../middleware/auth');
const { reauthLimiter } = require('../middleware/rateLimiter');
const approvals = require('../lib/approvals');
const strongFactor = require('../lib/strong-factor');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (welcomeRefused(req, res, auth)) return;
    req.auth = auth;
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const personOnly = (req, res, next) => (req.auth.type === 'admin'
  ? next()
  : res.status(403).json({ error: 'Only a person can decide an approval. An access key can only wait for one.' }));

async function me(req) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.auth.sub)).limit(1);
  return user || null;
}

// Who decided each approval, by email, for the people looking at the list.
async function withDeciders(rows) {
  const ids = [...new Set(rows.map((r) => r.decidedByUserId).filter(Boolean))];
  const people = ids.length
    ? await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users).where(inArray(schema.users.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.decidedByUserId);
    return { ...approvals.serialize(r), decidedBy: p ? { email: p.email, name: p.name } : null };
  });
}

// A key sees its own approvals. A person sees what is waiting, or with
// ?view=history everything that is no longer waiting: approved, used,
// declined, or left to expire.
router.get('/', async (req, res) => {
  try {
    if (req.auth.type === 'token') {
      const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.tokenId, req.auth.id))
        .orderBy(desc(schema.approvals.createdAt)).limit(50);
      return res.json({ approvals: rows.map(approvals.serialize) });
    }
    const now = new Date();
    const history = req.query.view === 'history';
    const where = history
      ? or(ne(schema.approvals.status, 'pending'), lte(schema.approvals.expiresAt, now))
      : and(eq(schema.approvals.status, 'pending'), gt(schema.approvals.expiresAt, now));
    const rows = await db.select().from(schema.approvals).where(where)
      .orderBy(desc(schema.approvals.createdAt)).limit(history ? 200 : 50);
    res.json({ approvals: await withDeciders(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  const row = await approvals.find(req.params.id);
  // A key asking about another key's approval gets the same answer as one asking
  // about an id that does not exist.
  if (!row || (req.auth.type === 'token' && row.tokenId !== req.auth.id)) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  if (req.auth.type === 'token') return res.json({ approval: approvals.serialize(row) });
  res.json({ approval: (await withDeciders([row]))[0] });
});

router.post('/:id/approve', personOnly, reauthLimiter, async (req, res) => {
  try {
    const row = await approvals.find(req.params.id);
    if (!row) return res.status(404).json({ error: 'Approval not found' });
    // Approving hands the key what the approver could do themselves, so the
    // approver has to hold that permission.
    if (!callerHasScope(req.auth, row.requiredScope)) {
      return res.status(403).json({ error: `Approving this needs the "${row.requiredScope}" permission.`, code: 'insufficient_scope' });
    }
    const user = await me(req);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (!await strongFactor.verify(user, req.body || {}, `approval:${row.id}`)) {
      return res.status(401).json({ error: 'Confirm with your passkey or a code from your authenticator app.', code: 'proof_required' });
    }
    const updated = await approvals.decide(row, { approve: true, user });
    res.json({ approval: (await withDeciders([updated]))[0] });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/:id/deny', personOnly, async (req, res) => {
  try {
    const row = await approvals.find(req.params.id);
    if (!row) return res.status(404).json({ error: 'Approval not found' });
    const user = await me(req);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    const updated = await approvals.decide(row, { approve: false, user });
    res.json({ approval: (await withDeciders([updated]))[0] });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
