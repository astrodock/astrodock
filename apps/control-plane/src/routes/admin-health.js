'use strict';

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireScope } = require('../middleware/auth');
const { getHealthData, getServerMetrics } = require('../runner/health');

const router = express.Router();
router.use(requireScope('deploy'));

router.get('/', async (req, res) => {
  const server = getServerMetrics();
  const appHealth = getHealthData();
  const apps = await db.select({ slug: schema.apps.slug, name: schema.apps.name, subdomain: schema.apps.subdomain, port: schema.apps.port })
    .from(schema.apps).where(eq(schema.apps.provisioned, true));
  const byslug = new Map(apps.map((a) => [a.slug, a]));

  const enriched = appHealth.map((e) => {
    const a = byslug.get(e.slug);
    return {
      slug: e.slug, name: a?.name || e.slug, subdomain: a?.subdomain || '', port: a?.port || 0,
      health: e.lastStatus, responseTime: e.responseTime, consecutiveFailures: e.consecutiveFailures,
      lastCheck: e.lastCheck, proc: e.proc
    };
  });

  res.json({ server, apps: enriched, checkedAt: new Date().toISOString() });
});

module.exports = router;
