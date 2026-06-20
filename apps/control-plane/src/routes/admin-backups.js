'use strict';

// Backup history + manual trigger (admin JWT only). Backups themselves run on the
// runner (Docker socket + backups volume); this just lists rows and proxies a run.

const express = require('express');
const { desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { runner } = require('../runner/client');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.select().from(schema.backups).orderBy(desc(schema.backups.createdAt)).limit(50);
    const last = rows.find((r) => r.status === 'success') || null;
    res.json({
      backups: rows,
      config: { intervalHours: config.backups.intervalHours, keep: config.backups.keep, dir: config.backups.dir },
      lastSuccess: last ? last.createdAt : null
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const r = await runner.backup('manual');
    res.status(r.status === 200 ? 200 : 502).json(r.body || { error: 'runner error' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
