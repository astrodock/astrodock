'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./src/config');
const { ping } = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { seedAdmin } = require('./src/seed');
const { reloadCaddyWithRetry, startCaddyReconciler } = require('./src/provision');
const { lockdownControlPlaneDb } = require('./src/provision/database');
const { isEnabled: secretEncryptionEnabled } = require('./src/lib/crypto');

const app = express();

// Trust one proxy (Caddy) so req.ip + rate limiting work.
app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, cb) => (config.isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
  credentials: true
}));
app.use(cookieParser());

// The pages.<base-domain> host serves entirely from the public Pages router (which has
// its own body parsers and ends in a 404, so /admin/* is never reachable there).
const pagesPublic = require('./src/routes/pages-public');
app.use((req, res, next) => (config.isPagesHost(req.hostname) ? pagesPublic(req, res, next) : next()));

// Webhook route needs the raw body; Pages admin needs multipart + a larger JSON limit.
// Both are mounted BEFORE the global express.json so they control their own parsing.
app.use('/webhooks', require('./src/routes/webhooks'));
app.use('/admin/pages', require('./src/routes/admin-pages'));

app.use(express.json({ limit: '1mb' }));

// Control-plane liveness (distinct from /admin/health monitor data).
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'astrodock-control-plane' }));

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
app.use('/admin/settings', require('./src/routes/admin-settings'));
app.use('/admin/notifications', require('./src/routes/admin-notifications'));
app.use('/admin/backups', require('./src/routes/admin-backups'));

// Fallback error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

async function start() {
  if (!config.adminJwtSecret) {
    console.error('FATAL: ASTRODOCK_ADMIN_JWT_SECRET is required.');
    process.exit(1);
  }

  if (!secretEncryptionEnabled()) {
    console.warn('WARNING: ASTRODOCK_SECRET_KEY is not set — secrets are stored in PLAINTEXT. Set it to encrypt secrets at rest (see SECURITY.md).');
  }

  await migrate();          // bring the schema up to date
  await ping();             // verify DB connectivity
  await lockdownControlPlaneDb(); // app roles can't connect to the control-plane DB
  await seedAdmin();        // idempotent admin seed

  // Push current routing to Caddy (retried; reconciler keeps it healed).
  reloadCaddyWithRetry().catch(() => {});
  startCaddyReconciler();
  // Platform self-health: probe DB/object-store/runner/cert + alert on transitions.
  require('./src/lib/platform-health').startPlatformHealth();
  // (app health monitoring runs in the runner container; this api reads app_health from the DB)

  app.listen(config.port, () => {
    console.log(`Astrodock control plane listening on :${config.port} (env=${config.env}, base=${config.baseDomain})`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start control plane:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
