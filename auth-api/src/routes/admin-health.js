const express = require('express');
const App = require('../models/App');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getHealthData, getServerMetrics } = require('../lib/health-checker');

const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  const serverMetrics = getServerMetrics();
  const appHealth = getHealthData();

  // Enrich health data with app details from DB
  const apps = await App.find({ isProvisioned: true }).select('slug name subdomain port');
  const appMap = new Map(apps.map(a => [a.slug, a]));

  const enriched = appHealth.map(entry => {
    const app = appMap.get(entry.slug);
    return {
      slug: entry.slug,
      name: app?.name || entry.slug,
      subdomain: app?.subdomain || '',
      port: app?.port || 0,
      health: entry.lastStatus,
      responseTime: entry.responseTime,
      consecutiveFailures: entry.consecutiveFailures,
      lastCheck: entry.lastCheck,
      pm2: entry.pm2
    };
  });

  res.json({
    server: serverMetrics,
    apps: enriched,
    checkedAt: new Date().toISOString()
  });
});

module.exports = router;
