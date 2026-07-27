'use strict';

const express = require('express');
const { desc, eq, ilike, and, inArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireScope } = require('../middleware/auth');

const router = express.Router();
router.use(requireScope('events:read'));

// Apps a per-app-scoped token may see (null = unrestricted: admin JWT or unscoped token).
function scopeSlugs(req) {
  const s = req.auth;
  return (s && s.type === 'token' && Array.isArray(s.appScope) && s.appScope.length) ? s.appScope : null;
}

// Recent deployments (no log body in the list view).
router.get('/deployments', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const scoped = scopeSlugs(req);
  const where = scoped ? inArray(schema.deployments.appSlug, scoped) : undefined;
  const rows = await db
    .select({
      id: schema.deployments.id, appSlug: schema.deployments.appSlug, status: schema.deployments.status,
      trigger: schema.deployments.trigger, commitHash: schema.deployments.commitHash,
      commitMessage: schema.deployments.commitMessage, error: schema.deployments.error,
      startedAt: schema.deployments.startedAt, finishedAt: schema.deployments.finishedAt,
      createdAt: schema.deployments.createdAt
    })
    .from(schema.deployments)
    .where(where)
    .orderBy(desc(schema.deployments.createdAt))
    .limit(limit);
  res.json({ deployments: rows });
});

// Auth logs, optionally filtered. Scoped tokens only see logs for their apps.
router.get('/auth-logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const conds = [];
  if (req.query.result) conds.push(eq(schema.authLogs.result, req.query.result));
  if (req.query.appId) conds.push(eq(schema.authLogs.appId, req.query.appId));
  if (req.query.email) conds.push(ilike(schema.authLogs.email, `%${req.query.email}%`));
  const scoped = scopeSlugs(req);
  if (scoped) conds.push(inArray(schema.authLogs.appId, scoped));

  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(schema.authLogs)
    .where(where)
    .orderBy(desc(schema.authLogs.createdAt))
    .limit(limit);
  res.json({ logs: rows });
});

// Audit / system event trail. Admin-only — scoped tokens (agents) can't read the
// platform audit log even though they pass the deploy scope on this router.
router.get('/events', async (req, res) => {
  if (req.auth.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  const conds = [];
  if (req.query.category) conds.push(eq(schema.events.category, req.query.category));
  if (req.query.appSlug) conds.push(eq(schema.events.appSlug, req.query.appSlug));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(schema.events)
    .where(where)
    .orderBy(desc(schema.events.createdAt))
    .limit(limit);
  res.json({ events: rows });
});

module.exports = router;
