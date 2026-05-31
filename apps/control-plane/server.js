'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./src/config');
const { ping } = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { seedAdmin } = require('./src/seed');
const { reloadCaddyFromDb } = require('./src/provision');
const { startHealthChecker } = require('./src/runner/health');

const app = express();

// Trust one proxy (Caddy) so req.ip + rate limiting work.
app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, cb) => (config.isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
  credentials: true
}));

// Webhook route needs the raw body, so mount BEFORE express.json().
app.use('/webhooks', require('./src/routes/webhooks'));

app.use(express.json({ limit: '1mb' }));

// Control-plane liveness (distinct from /admin/health monitor data).
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'toolstead-control-plane' }));

// Hosted end-user account page.
app.get('/account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));

app.use('/verify', require('./src/routes/verify'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', require('./src/routes/admin-auth'));
app.use('/admin/health', require('./src/routes/admin-health'));
app.use('/admin/users', require('./src/routes/admin-users'));
app.use('/admin/apps', require('./src/routes/admin-apps'));
app.use('/admin/tokens', require('./src/routes/admin-tokens'));
app.use('/admin/activity', require('./src/routes/admin-activity'));

// Fallback error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

async function start() {
  if (!config.adminJwtSecret) {
    console.error('FATAL: TOOLSTEAD_ADMIN_JWT_SECRET is required.');
    process.exit(1);
  }

  await migrate();          // bring the schema up to date
  await ping();             // verify DB connectivity
  await seedAdmin();        // idempotent admin seed

  // Push current routing to Caddy (best-effort — Caddy may still be booting).
  reloadCaddyFromDb().catch(() => {});

  startHealthChecker();

  app.listen(config.port, () => {
    console.log(`Toolstead control plane listening on :${config.port} (env=${config.env}, base=${config.baseDomain})`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start control plane:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
