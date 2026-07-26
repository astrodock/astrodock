'use strict';

// Platform settings surface (admin JWT only — not exposed to scoped API tokens).
//   GET   /admin/settings         → operational settings (effective + source),
//                                    read-only infra diagnostics, readiness checks
//   PATCH /admin/settings         → set one or more operational overrides
//
// Mounted after the global express.json in server.js, so the body is already parsed.

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const settings = require('../lib/settings');
const { emitEvent } = require('../lib/events');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    res.json({
      settings: await settings.effective(),
      diagnostics: settings.diagnostics(),
      // The port-exposure card needs a round-trip to the runner (only it can see
      // the Docker socket), so it is appended to the synchronous checks.
      readiness: [...settings.readiness(), await settings.exposureCheck()]
    });
  } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : body;
    const changed = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'updates') continue;
      try { await settings.setSetting(key, value, req.auth.email); changed.push(key); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }
    if (changed.length) {
      emitEvent({
        category: 'audit', type: 'settings.update', severity: 'info',
        actorType: 'admin', actor: req.auth.email, ip: req.ip,
        targetType: 'setting', targetId: changed.join(','),
        message: `updated ${changed.join(', ')}`
      }).catch(() => {});
    }
    res.json({ settings: await settings.effective(), updated: changed });
  } catch (err) { next(err); }
});

module.exports = router;
