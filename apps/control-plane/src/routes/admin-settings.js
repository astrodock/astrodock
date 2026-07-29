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
      readiness: [...(await settings.readiness()), await settings.exposureCheck()],
      email: await require('../lib/email-config').describe()
    });
  } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    // Turning on "require MFA" without holding a factor yourself locks you out on
    // the next sign-in, and there is nobody left to turn it back off.
    const body0 = req.body && typeof req.body === 'object' ? req.body : {};
    const updates0 = body0.updates && typeof body0.updates === 'object' ? body0.updates : body0;
    if (updates0['security.require_mfa'] === 'on' && req.auth?.sub) {
      const factors = require('../lib/auth-factors');
      const f = await factors.factorsFor(req.auth.sub).catch(() => null);
      if (f && !factors.hasSecondFactor(f)) {
        return res.status(400).json({
          error: 'Set up a passkey or authenticator app on your own account first — otherwise this would lock you out.'
        });
      }
    }
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

// ── Version + update check ───────────────────────────────────────────────────

router.get('/version', async (req, res) => {
  const updates = require('../lib/updates');
  // force=1 is the "Check now" button; the default read is served from cache so
  // opening Settings does not call out to GitHub every time.
  res.json(await updates.check({ force: req.query.force === '1' }));
});

// Applying an update is the most consequential button in the product: it replaces
// every running container. Step-up re-auth, and audited before it starts rather
// than after, since "after" may not arrive.
const { requireRecentAuth } = require('../lib/sessions');

router.get('/update/describe', async (req, res) => {
  try {
    const { runner } = require('../runner/client');
    const r = await runner.updateDescribe();
    res.status(r.status === 200 ? 200 : 502).json(r.body || { ok: false, reason: 'The runner did not answer.' });
  } catch (err) {
    res.json({ ok: false, reason: `The runner is unreachable, so an update cannot be started: ${err.message}` });
  }
});

router.post('/update', requireRecentAuth, async (req, res) => {
  const updates = require('../lib/updates');
  const version = require('../lib/version');
  try {
    const current = version.resolve();
    const target = (req.body?.toVersion || '').trim() || null;

    emitEvent({
      category: 'audit', type: 'update.requested', severity: 'critical',
      actorType: 'admin', actor: req.auth.email, ip: req.ip,
      targetType: 'platform', targetId: 'astrodock',
      message: `requested an update to ${target || 'the latest release'}`
    }).catch(() => {});

    const { runner } = require('../runner/client');
    const r = await runner.update({ toVersion: target, currentVersion: current.version, actor: req.auth.email });
    if (r.status !== 200) return res.status(r.status || 502).json(r.body || { error: 'The runner refused.' });

    updates._reset();   // the version it reports is about to change
    res.json({ ...r.body, note: 'The dashboard will go away for a minute while the platform restarts.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Email provider ───────────────────────────────────────────────────────────
// Kept off the generic settings PATCH: these carry credentials, so they are
// written through email-config (which encrypts them) and never read back out.

const emailConfig = require('../lib/email-config');
const { sendTestEmail } = require('../lib/email');

router.get('/email', async (req, res, next) => {
  try { res.json(await emailConfig.describe()); } catch (err) { next(err); }
});

router.put('/email', async (req, res, next) => {
  try {
    const described = await emailConfig.update(req.body || {}, req.auth.email);
    emitEvent({
      category: 'audit', type: 'settings.email_update', severity: 'info',
      actorType: 'admin', actor: req.auth.email, ip: req.ip,
      targetType: 'setting', targetId: 'email',
      message: `email delivery set to ${described.provider}`
    }).catch(() => {});
    res.json(described);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/email/test', async (req, res) => {
  const to = (req.body?.to || '').trim();
  try {
    res.json(await sendTestEmail(to));
  } catch (err) {
    // A failed test is the expected outcome of a wrong password or a blocked
    // port, so it is a 400 with the provider's own words — not a 500.
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
