'use strict';

// Notification rules + delivery log (admin JWT only).
//   GET    /admin/notifications            → rules (implicit default shown when none stored)
//   POST   /admin/notifications            → create a rule
//   PATCH  /admin/notifications/:id        → update a rule
//   DELETE /admin/notifications/:id        → delete a rule
//   POST   /admin/notifications/test       → send a one-off test to a channel/target
//   GET    /admin/notifications/deliveries → recent delivery log (debug "did it send?")

const express = require('express');
const { desc } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const notifications = require('../lib/notifications');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try { res.json({ rules: await notifications.listRules() }); }
  catch (err) { next(err); }
});

router.get('/deliveries', async (req, res, next) => {
  try {
    const rows = await db.select().from(schema.notificationDeliveries)
      .orderBy(desc(schema.notificationDeliveries.createdAt)).limit(100);
    res.json({ deliveries: rows });
  } catch (err) { next(err); }
});

router.post('/test', async (req, res, next) => {
  try {
    const result = await notifications.sendTest(req.body || {});
    res.status(result.status === 'sent' ? 200 : 502).json({ result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/', async (req, res, next) => {
  try { res.status(201).json({ rule: await notifications.createRule(req.body || {}) }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const rule = await notifications.updateRule(req.params.id, req.body || {});
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await notifications.deleteRule(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Rule not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
