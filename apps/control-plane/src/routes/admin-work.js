'use strict';

// Work items: what the operator is going to do.
//
// Nobody is waiting on one of these directly, which is exactly why they are a
// separate thing from feedback. An item can say "the tz offset is applied twice
// in formatDuration()" without any risk of a user reading it, and the person who
// reported the bug hears "fixed, reload the page" through the feedback thread
// instead.

const express = require('express');
const { and, eq, desc, inArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const fb = require('../lib/feedback');
const { requireScope, requirePermission, tokenAllowsApp } = require('../middleware/auth');

const router = express.Router();
router.use(requireScope('work:read'));

router.param('slug', async (req, res, next, slug) => {
  try {
    const [app] = await db.select().from(schema.apps)
      .where(eq(schema.apps.slug, String(slug).toLowerCase())).limit(1);
    if (!app) return res.status(404).json({ error: 'Unknown app' });
    if (!tokenAllowsApp(req.auth, app.slug)) return res.status(403).json({ error: 'This key is not scoped to that app' });
    req.app_ = app;
    next();
  } catch (err) { next(err); }
});

async function byKey(appId, key) {
  const [row] = await db.select().from(schema.workItems)
    .where(and(eq(schema.workItems.appId, appId), eq(schema.workItems.key, String(key).toUpperCase()))).limit(1);
  return row || null;
}

router.get('/:slug', async (req, res) => {
  const where = req.query.status
    ? and(eq(schema.workItems.appId, req.app_.id), eq(schema.workItems.status, String(req.query.status)))
    : eq(schema.workItems.appId, req.app_.id);
  const rows = await db.select().from(schema.workItems).where(where)
    .orderBy(desc(schema.workItems.createdAt)).limit(Math.min(Number(req.query.limit) || 200, 500));

  // Who is waiting to hear about each one. An item with three reporters is a
  // different priority from one with none, and that is only visible here.
  const links = rows.length
    ? await db.select().from(schema.feedbackWorkItems)
      .where(inArray(schema.feedbackWorkItems.workItemId, rows.map((r) => r.id)))
    : [];
  const reports = links.length
    ? await db.select().from(schema.feedback)
      .where(inArray(schema.feedback.id, [...new Set(links.map((l) => l.feedbackId))]))
    : [];
  const keyOf = new Map(reports.map((f) => [f.id, f.key]));

  res.json({
    items: rows.map((r) => ({
      ...r,
      feedback: links.filter((l) => l.workItemId === r.id).map((l) => keyOf.get(l.feedbackId)).filter(Boolean)
    }))
  });
});

router.get('/:slug/:key', async (req, res) => {
  const item = await byKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown work item' });
  const links = await db.select().from(schema.feedbackWorkItems)
    .where(eq(schema.feedbackWorkItems.workItemId, item.id));
  const reports = links.length
    ? await db.select().from(schema.feedback).where(inArray(schema.feedback.id, links.map((l) => l.feedbackId)))
    : [];
  const relations = await db.select().from(schema.workItemRelations)
    .where(eq(schema.workItemRelations.fromId, item.id));
  res.json({ item, feedback: reports.map((f) => ({ key: f.key, title: f.title, status: f.status })), relations });
});

router.post('/:slug', requirePermission('work:write'), async (req, res) => {
  try {
    const row = await fb.createWorkItem({ appId: req.app_.id, ...req.body });
    res.status(201).json({ item: row });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:slug/:key/status', requirePermission('work:write'), async (req, res) => {
  const item = await byKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown work item' });
  try {
    res.json({ item: await fb.setWorkStatus(item.id, String(req.body.status || '')) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:slug/:key', requirePermission('work:write'), async (req, res) => {
  const item = await byKey(req.app_.id, req.params.key);
  if (!item) return res.status(404).json({ error: 'Unknown work item' });
  // A whitelist, so a PATCH cannot reach `key`, `appId` or the timestamps.
  const patch = { updatedAt: new Date() };
  for (const f of ['title', 'context', 'body', 'priority', 'size', 'type', 'area']) {
    if (req.body[f] != null) patch[f] = String(req.body[f]);
  }
  if (patch.type && !fb.WORK_TYPES.includes(patch.type)) {
    return res.status(400).json({ error: `Unknown type: ${patch.type}` });
  }
  const [row] = await db.update(schema.workItems).set(patch)
    .where(eq(schema.workItems.id, item.id)).returning();
  res.json({ item: row });
});

router.post('/:slug/:key/relate', requirePermission('work:write'), async (req, res) => {
  const from = await byKey(req.app_.id, req.params.key);
  const to = await byKey(req.app_.id, req.body.to);
  if (!from || !to) return res.status(404).json({ error: 'Unknown work item' });
  try {
    await fb.relate(from.id, to.id, String(req.body.kind || 'relates_to'));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
