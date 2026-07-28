'use strict';

// Backup history, manual trigger, download, upload and restore (admin JWT only).
//
// The work all happens on the runner — it holds the Docker socket and the backups
// volume, and a restore drops the database this process is answering from. These
// routes are the authenticated front door and the audit trail.
//
// Download and restore are step-up actions. A dump is a complete copy of the
// platform: every app secret, every token hash, every user. Handing one out is a
// bigger deal than reading a page, and overwriting the database with one is
// bigger still.

const express = require('express');
const { desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { requireRecentAuth } = require('../lib/sessions');
const { emitEvent } = require('../lib/events');
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

router.post('/', async (req, res) => {
  try {
    const r = await runner.backup('manual');
    res.status(r.status === 200 ? 200 : 502).json(r.body || { error: 'runner error' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Stream a dump out through the api, so the runner never has to be exposed.
router.get('/:id/file', requireRecentAuth, async (req, res) => {
  try {
    const upstream = await runner.backupFile(req.params.id);
    if (!upstream.ok) {
      const body = await upstream.text();
      let error = 'Could not read that backup.';
      try { error = JSON.parse(body).error || error; } catch { /* keep the default */ }
      return res.status(upstream.status).json({ error });
    }
    emitEvent({
      category: 'audit', type: 'backup.downloaded', severity: 'warning',
      actorType: 'admin', actor: req.auth.email, ip: req.ip,
      targetType: 'backup', targetId: req.params.id,
      message: 'downloaded a database backup'
    }).catch(() => {});

    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Bring a dump back onto the box. Not step-up on its own: uploading only adds a
// row to the list. Doing anything WITH it is the guarded part.
router.post('/upload', express.raw({ type: '*/*', limit: '2gb' }), async (req, res) => {
  try {
    const r = await runner.backupUpload(req.body, req.auth.email);
    if (r.status !== 200) return res.status(r.status || 502).json(r.body || { error: 'runner error' });
    res.json(r.body);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/:id/restore', requireRecentAuth, async (req, res) => {
  try {
    emitEvent({
      category: 'audit', type: 'restore.requested', severity: 'critical',
      actorType: 'admin', actor: req.auth.email, ip: req.ip,
      targetType: 'backup', targetId: req.params.id,
      message: 'requested a database restore'
    }).catch(() => {});

    const r = await runner.backupRestore(req.params.id, req.auth.email);
    if (r.status !== 200) return res.status(r.status || 502).json(r.body || { error: 'runner error' });

    // The runner restarts this process a moment after answering, so say so —
    // the dashboard is about to stop responding on purpose, and an operator
    // watching it go quiet deserves to know that was the plan.
    res.json({ ...r.body, apiRestarting: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
