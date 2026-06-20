'use strict';

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireScope, tokenAllowsApp } = require('../middleware/auth');
const { getServerMetrics } = require('../runner/health');
const platformHealth = require('../lib/platform-health');

const router = express.Router();
router.use(requireScope('deploy'));

// Platform self-health snapshot (DB / object store / runner / TLS cert).
router.get('/platform', async (req, res) => {
  res.json(platformHealth.getLast() || await platformHealth.probePlatform());
});

// App health is written to app_health by the runner; read it from the DB here.
router.get('/', async (req, res) => {
  const server = getServerMetrics();
  let apps = await db.select({ slug: schema.apps.slug, name: schema.apps.name, subdomain: schema.apps.subdomain, port: schema.apps.port })
    .from(schema.apps).where(eq(schema.apps.provisioned, true));
  apps = apps.filter((a) => tokenAllowsApp(req.auth, a.slug)); // per-app-scoped tokens see only their apps
  const health = await db.select().from(schema.appHealth);
  const byslug = new Map(health.map((h) => [h.slug, h]));

  const enriched = apps.map((a) => {
    const h = byslug.get(a.slug) || {};
    return {
      slug: a.slug, name: a.name, subdomain: a.subdomain, port: a.port,
      health: h.status || 'unknown', responseTime: h.responseTime ?? null,
      consecutiveFailures: h.consecutiveFailures ?? 0, lastCheck: h.lastCheck || null, proc: h.proc || null
    };
  });

  res.json({ server, apps: enriched, checkedAt: new Date().toISOString() });
});

module.exports = router;
