const express = require('express');
const { execSync, spawn } = require('child_process');
const App = require('../models/App');
const Deployment = require('../models/Deployment');
const { requireAdmin } = require('../middleware/requireAdmin');
const { generateAppSecret } = require('../lib/generateSecret');
const { provisionApp, unprovisionApp } = require('../lib/provision');
const { listRepos, createWebhook, deleteWebhook, generateWebhookSecret } = require('../lib/github');
const { runDeploy } = require('../lib/deploy');

const router = express.Router();
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'seniorverse.dev';
const BASE_PORT = 3101; // auth is 3100, apps start at 3101

// All routes require admin
router.use(requireAdmin);

// ── GitHub Integration (must be before /:slug routes) ─────

// List repos available to connect
router.get('/github/repos', async (req, res) => {
  try {
    const repos = await listRepos();
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: `Failed to list repos: ${err.message}` });
  }
});

// PM2 status for all apps (must be before /:slug routes)
router.get('/status/all', async (req, res) => {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const processes = JSON.parse(output);
    const statuses = {};
    for (const proc of processes) {
      statuses[proc.name] = proc.pm2_env.status;
    }
    res.json({ statuses });
  } catch {
    res.json({ statuses: {} });
  }
});

// ── App CRUD ──────────────────────────────────────────────

// List all apps (secrets are excluded by toJSON)
router.get('/', async (req, res) => {
  const apps = await App.find().sort({ name: 1 });
  res.json({ apps });
});

// Get single app
router.get('/:slug', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json({ app });
});

// Register a new app — returns the secret once
router.post('/', async (req, res) => {
  const { slug, name, description, subdomain, usePlatformAuth = true, usePlatformDb = true } = req.body;

  if (!slug || !name || !subdomain) {
    return res.status(400).json({ error: 'slug, name, and subdomain are required' });
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be lowercase alphanumeric with hyphens only' });
  }

  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ error: 'subdomain must be lowercase alphanumeric with hyphens only' });
  }

  const existing = await App.findOne({ $or: [{ slug }, { subdomain }] });
  if (existing) {
    if (existing.slug === slug) {
      return res.status(409).json({ error: 'An app with this slug already exists' });
    }
    return res.status(409).json({ error: 'An app with this subdomain already exists' });
  }

  // Auto-assign the next available port
  const highestPortDoc = await App.findOne({ port: { $exists: true } }).sort({ port: -1 }).select('port');
  const port = highestPortDoc && highestPortDoc.port ? highestPortDoc.port + 1 : BASE_PORT;

  const appSecret = generateAppSecret();

  // Pre-populate system env vars
  const crypto = require('crypto');
  const envVars = [
    { key: 'PORT', value: String(port), isSystem: true },
    { key: 'SPACES_PREFIX', value: slug, isSystem: true },
  ];

  if (usePlatformDb) {
    // Build a per-app MONGODB_URI with the app's database in the path
    // e.g., .../auth?params → .../inventory-tracker?params
    const appMongoUri = process.env.MONGODB_URI.replace(/\/[^/?]+(\?|$)/, '/' + slug + '$1');
    envVars.push({ key: 'MONGODB_URI', value: appMongoUri, isSystem: true });
    envVars.push({ key: 'DB_NAME', value: slug, isSystem: true });
  }

  if (usePlatformAuth) {
    envVars.push({ key: 'AUTH_URL', value: `http://localhost:${process.env.PORT || 3100}`, isSystem: true });
    envVars.push({ key: 'APP_ID', value: slug, isSystem: true });
    envVars.push({ key: 'APP_SECRET', value: appSecret, isSystem: true });
    envVars.push({ key: 'APP_JWT_SECRET', value: crypto.randomBytes(32).toString('hex'), isSystem: true });
  }

  try {
    const app = await App.create({ slug, name, description, subdomain, port, appSecret, usePlatformAuth, usePlatformDb, envVars });

    res.status(201).json({
      app: app.toJSON(),
      appSecret
    });
  } catch (err) {
    console.error('App creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update app settings
router.patch('/:slug', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const { usePlatformAuth, usePlatformDb } = req.body;

  if (typeof usePlatformAuth === 'boolean') app.usePlatformAuth = usePlatformAuth;
  if (typeof usePlatformDb === 'boolean') app.usePlatformDb = usePlatformDb;

  await app.save();
  res.json({ app });
});

// Delete app
router.delete('/:slug', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  // Clean up webhook
  if (app.githubRepo && app.webhookId) {
    try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ }
  }

  if (app.isProvisioned) {
    await unprovisionApp(app);
  }

  await Deployment.deleteMany({ appSlug: app.slug });
  await App.deleteOne({ slug: req.params.slug });
  res.status(204).end();
});

// Rotate secret — returns the new secret once
router.post('/:slug/rotate-secret', async (req, res) => {
  const appSecret = generateAppSecret();
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  app.appSecret = appSecret;
  // Update the system env var too
  const envVar = app.envVars.find(v => v.key === 'APP_SECRET');
  if (envVar) envVar.value = appSecret;
  await app.save();

  res.json({
    app: app.toJSON(),
    appSecret
  });
});

// ── Provisioning ──────────────────────────────────────────

router.post('/:slug/provision', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  try {
    const results = await provisionApp(app);
    if (!app.isProvisioned) {
      app.isProvisioned = true;
      await app.save();
    }
    res.json({ message: app.isProvisioned ? 'App re-provisioned successfully' : 'App provisioned successfully', details: results });
  } catch (err) {
    const isEnvError = err.message.includes('not available in this environment');
    const status = isEnvError ? 422 : 500;
    res.status(status).json({ error: `Provisioning failed: ${err.message}` });
  }
});

// ── GitHub Integration ────────────────────────────────────

// Connect a GitHub repo to an app
router.post('/:slug/connect-repo', async (req, res) => {
  const { githubRepo, branch, repoPath } = req.body;

  if (!githubRepo) {
    return res.status(400).json({ error: 'githubRepo is required (e.g., "your-org/repo-name")' });
  }

  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  // Remove old webhook if switching repos
  if (app.githubRepo && app.webhookId) {
    try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ }
  }

  // Create webhook
  const webhookSecret = generateWebhookSecret();
  const callbackUrl = `https://auth.${BASE_DOMAIN}/webhooks/github`;

  try {
    const webhookId = await createWebhook(githubRepo, callbackUrl, webhookSecret);
    app.githubRepo = githubRepo;
    app.branch = branch || 'main';
    app.repoPath = repoPath || '';
    app.webhookId = webhookId;
    app.webhookSecret = webhookSecret;
    await app.save();

    res.json({ message: `Connected to ${githubRepo}`, app: app.toJSON() });
  } catch (err) {
    res.status(500).json({ error: `Failed to set up webhook: ${err.message}` });
  }
});

// Disconnect GitHub repo
router.post('/:slug/disconnect-repo', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  if (app.githubRepo && app.webhookId) {
    try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ }
  }

  app.githubRepo = '';
  app.branch = 'main';
  app.webhookId = null;
  app.webhookSecret = '';
  await app.save();

  res.json({ message: 'Repository disconnected', app: app.toJSON() });
});

// ── Deploys ───────────────────────────────────────────────

// Manual deploy trigger
router.post('/:slug/deploy', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  if (!app.githubRepo) {
    return res.status(400).json({ error: 'No GitHub repo connected' });
  }

  if (!app.isProvisioned) {
    return res.status(400).json({ error: 'App must be provisioned before deploying' });
  }

  // Guardrail: check GITHUB_PAT before kicking off async deploy
  if (!process.env.GITHUB_PAT) {
    return res.status(422).json({ error: 'GitHub PAT not configured. Set the GITHUB_PAT environment variable to enable deployments.' });
  }

  // Run deploy async — return immediately
  runDeploy(app, { trigger: 'manual' }).catch(err => {
    console.error(`Manual deploy failed for ${app.slug}:`, err);
  });

  res.json({ message: 'Deploy triggered' });
});

// List deployments for an app
router.get('/:slug/deployments', async (req, res) => {
  const deployments = await Deployment.find({ appSlug: req.params.slug })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('-log'); // Exclude full log from list view
  res.json({ deployments });
});

// Get a single deployment with full log
router.get('/:slug/deployments/:id', async (req, res) => {
  const deployment = await Deployment.findById(req.params.id);
  if (!deployment || deployment.appSlug !== req.params.slug) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  res.json({ deployment });
});

// ── Environment Variables ─────────────────────────────────

// Get env vars for an app (values masked for system vars via toJSON)
router.get('/:slug/env', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json({ envVars: app.toJSON().envVars });
});

// Set/update an env var
router.put('/:slug/env/:key', async (req, res) => {
  const { value } = req.body;
  if (value === undefined) {
    return res.status(400).json({ error: 'value is required' });
  }

  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const existing = app.envVars.find(v => v.key === req.params.key);
  if (existing) {
    if (existing.isSystem) {
      return res.status(400).json({ error: 'Cannot modify system env var' });
    }
    existing.value = value;
  } else {
    app.envVars.push({ key: req.params.key, value, isSystem: false });
  }

  await app.save();
  res.json({ envVars: app.toJSON().envVars });
});

// Bulk import env vars from .env format
router.post('/:slug/env/bulk', async (req, res) => {
  const { raw } = req.body;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'raw string is required' });
  }

  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const lines = raw.split('\n');
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    if (!key) continue;

    // Don't overwrite system vars
    const existing = app.envVars.find(v => v.key === key);
    if (existing && existing.isSystem) {
      skipped++;
      continue;
    }

    if (existing) {
      existing.value = value;
    } else {
      app.envVars.push({ key, value, isSystem: false });
    }
    added++;
  }

  await app.save();
  res.json({ added, skipped, envVars: app.toJSON().envVars });
});

// Delete an env var
router.delete('/:slug/env/:key', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const existing = app.envVars.find(v => v.key === req.params.key);
  if (!existing) return res.status(404).json({ error: 'Env var not found' });
  if (existing.isSystem) {
    return res.status(400).json({ error: 'Cannot delete system env var' });
  }

  app.envVars = app.envVars.filter(v => v.key !== req.params.key);
  await app.save();
  res.json({ envVars: app.toJSON().envVars });
});

// ── PM2 Process Management ────────────────────────────────

// Get PM2 status for an app
router.get('/:slug/status', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const pmName = `${app.slug}-api`;
  try {
    const output = execSync(`pm2 jlist 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
    const processes = JSON.parse(output);
    const proc = processes.find(p => p.name === pmName);
    if (!proc) {
      return res.json({ status: 'stopped', pid: null, uptime: null, restarts: 0, memory: 0 });
    }
    res.json({
      status: proc.pm2_env.status,
      pid: proc.pid,
      uptime: proc.pm2_env.pm_uptime,
      restarts: proc.pm2_env.restart_time,
      memory: proc.monit?.memory || 0,
      cpu: proc.monit?.cpu || 0
    });
  } catch {
    res.json({ status: 'unavailable', pid: null, uptime: null, restarts: 0, memory: 0 });
  }
});

// Write a marker to the app's PM2 log file
function writeLogMarker(pmName, message) {
  const fs = require('fs');
  const homeDir = process.env.HOME || '/home/deploy';
  const logFile = `${homeDir}/.pm2/logs/${pmName}-out.log`;
  const marker = `\n════ ${message} at ${new Date().toISOString()} ════\n`;
  try { fs.appendFileSync(logFile, marker); } catch { /* best effort */ }
}

// Restart PM2 process
router.post('/:slug/restart', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const pmName = `${app.slug}-api`;
  try {
    writeLogMarker(pmName, 'Manual restart');
    execSync(`pm2 restart ${pmName} 2>&1`, { encoding: 'utf8', timeout: 10000 });
    res.json({ message: 'Process restarted' });
  } catch (err) {
    res.status(500).json({ error: `Restart failed: ${err.message}` });
  }
});

// Stop PM2 process
router.post('/:slug/stop', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const pmName = `${app.slug}-api`;
  try {
    writeLogMarker(pmName, 'Process stopped');
    execSync(`pm2 stop ${pmName} 2>&1`, { encoding: 'utf8', timeout: 10000 });
    res.json({ message: 'Process stopped' });
  } catch (err) {
    res.status(500).json({ error: `Stop failed: ${err.message}` });
  }
});

// ── App Logs ──────────────────────────────────────────────

router.get('/:slug/logs', async (req, res) => {
  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const lines = parseInt(req.query.lines) || 100;
  const pmName = `${app.slug}-api`;
  const homeDir = process.env.HOME || '/home/deploy';
  const outLog = `${homeDir}/.pm2/logs/${pmName}-out.log`;
  const errLog = `${homeDir}/.pm2/logs/${pmName}-error.log`;

  function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  }

  try {
    // Read both log files, merge, and sort by timestamp
    const allLines = [];

    for (const logFile of [outLog, errLog]) {
      try {
        const content = execSync(`tail -n ${lines} "${logFile}" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        const cleaned = stripAnsi(content);
        for (const line of cleaned.split('\n')) {
          if (line.trim()) allLines.push(line);
        }
      } catch { /* file may not exist */ }
    }

    // Sort by timestamp prefix (YYYY-MM-DD HH:mm:ss)
    allLines.sort((a, b) => {
      const tsA = a.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const tsB = b.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (tsA && tsB) return tsA[1].localeCompare(tsB[1]);
      if (tsA) return -1;
      if (tsB) return 1;
      return 0;
    });

    // Keep the last N lines after merge
    const merged = allLines.slice(-lines).join('\n');

    res.json({ logs: merged || 'No logs available' });
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('not found') || msg.includes('enoent')) {
      res.json({ logs: 'Logs are not available in this environment.' });
    } else {
      res.json({ logs: 'No logs available' });
    }
  }
});

// ── Terminal (streaming command execution) ───────────────

const APPS_DIR = process.env.APPS_DIR || '/opt/apps';
const MAX_EXEC_TIMEOUT = 5 * 60 * 1000; // 5 minutes

router.get('/:slug/exec', async (req, res) => {
  const command = req.query.command;
  if (!command || !command.trim()) {
    return res.status(400).json({ error: 'command query parameter is required' });
  }

  const app = await App.findOne({ slug: req.params.slug });
  if (!app) return res.status(404).json({ error: 'App not found' });

  const cwd = `${APPS_DIR}/${app.slug}-api`;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/caddy buffering
  res.flushHeaders();

  // Build env from the app's own vars only — don't leak auth-api secrets
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV || 'production' };
  if (app.getRawEnvVars) {
    for (const v of app.getRawEnvVars()) {
      env[v.key] = v.value;
    }
  }

  const child = spawn('sh', ['-c', command], {
    cwd,
    env,
    timeout: MAX_EXEC_TIMEOUT
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  child.stdout.on('data', (chunk) => {
    send('stdout', chunk.toString());
  });

  child.stderr.on('data', (chunk) => {
    send('stderr', chunk.toString());
  });

  child.on('close', (code) => {
    send('exit', { code });
    res.end();
  });

  child.on('error', (err) => {
    send('error', err.message);
    res.end();
  });

  // If the client disconnects, kill the process
  req.on('close', () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  });
});

module.exports = router;
