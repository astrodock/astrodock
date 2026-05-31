'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { eq, and, desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireScope } = require('../middleware/auth');
const { getAppBySlug, getAppEnvVars, serializeApp, serializeEnvVar } = require('../lib/apps');
const { applyManifest } = require('../lib/apply');
const { computeEnv, computeMissingRequired } = require('../lib/env-compute');
const { provisionApp, reloadCaddyFromDb } = require('../provision');
const { runDeploy } = require('../runner/deploy');
const pc = require('../runner/process-control');
const { generateAppSecret, generateWebhookSecret } = require('../lib/ids');
const { listRepos, createWebhook, deleteWebhook } = require('../lib/github');

const router = express.Router();
router.use(requireScope('deploy'));

const scheme = () => (config.tlsMode === 'off' ? 'http' : 'https');

// ── must come before /:slug ───────────────────────────────────────────────────
router.get('/github/repos', async (req, res) => {
  if (!config.github.pat) return res.status(422).json({ error: 'GitHub PAT not configured (TOOLSTEAD_GITHUB_PAT)' });
  try { res.json({ repos: await listRepos() }); }
  catch (err) { res.status(500).json({ error: `Failed to list repos: ${err.message}` }); }
});

router.get('/status/all', async (req, res) => {
  const apps = await db.select().from(schema.apps);
  res.json({ statuses: pc.statusAll(apps) });
});

// ── apply a manifest (CLI `apply`) ──────────────────────────────────────────────
router.post('/apply', async (req, res) => {
  const manifest = req.body?.manifest || req.body;
  const prune = !!(req.body?.prune || req.query.prune);
  try {
    const { app, created } = await applyManifest(manifest, { prune });

    // Optionally connect repo (githubRepo may come from manifest.source).
    const githubRepo = manifest?.source?.githubRepo;
    let repoConnected = false;
    if (githubRepo && config.github.pat && githubRepo !== app.githubRepo) {
      try { await connectRepoInternal(app, githubRepo, app.branch, app.repoPath); repoConnected = true; }
      catch (e) { /* surfaced in response */ res.locals.repoError = e.message; }
    }

    // Provision (DB/storage/Caddy).
    const { app: provisioned, results } = await provisionApp(await getAppBySlug(app.slug));

    res.status(created ? 201 : 200).json({
      created,
      app: serializeApp(provisioned),
      appSecret: created ? app.appSecret : undefined,
      repoConnected,
      repoError: res.locals.repoError,
      provision: results
    });
  } catch (err) {
    if (err.status === 400 && err.errors) return res.status(400).json({ error: err.message, errors: err.errors });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const apps = await db.select().from(schema.apps).orderBy(schema.apps.name);
  res.json({ apps: apps.map(serializeApp) });
});

router.get('/:slug', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const envVars = await getAppEnvVars(app.id);
  res.json({
    app: serializeApp(app),
    envVars: envVars.map(serializeEnvVar),
    missingRequired: computeMissingRequired(app, envVars)
  });
});

// Manual create (admin UI) — builds a manifest from the body and applies it.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const manifest = {
    schemaVersion: '1',
    slug: b.slug, name: b.name, subdomain: b.subdomain, description: b.description || '',
    source: { branch: b.branch || 'main', repoPath: b.repoPath || '' },
    runtime: { type: b.runtimeType || b.runtime?.type || 'node' },
    auth: { mode: b.authMode || b.auth?.mode || 'platform' },
    database: { mode: b.databaseMode || b.database?.mode || 'none' },
    storage: { mode: b.storageMode || b.storage?.mode || 'none' },
    env: []
  };
  try {
    const { app, created } = await applyManifest(manifest);
    if (!created) return res.status(409).json({ error: 'An app with this slug already exists' });
    res.status(201).json({ app: serializeApp(app), appSecret: app.appSecret });
  } catch (err) {
    if (err.errors) return res.status(err.status || 400).json({ error: err.message, errors: err.errors });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update structural fields / modes.
router.patch('/:slug', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const b = req.body || {};
  const update = { updatedAt: new Date() };
  const map = {
    name: 'name', description: 'description',
    authMode: 'authMode', databaseMode: 'databaseMode', storageMode: 'storageMode',
    runtimeType: 'runtimeType', buildCommand: 'buildCommand', dockerfile: 'dockerfile',
    branch: 'branch', repoPath: 'repoPath', subdomain: 'subdomain'
  };
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) update[col] = b[k];
  const rows = await db.update(schema.apps).set(update).where(eq(schema.apps.id, app.id)).returning();
  res.json({ app: serializeApp(rows[0]) });
});

router.delete('/:slug', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  try { pc.stop(app); } catch { /* best effort */ }
  await db.delete(schema.deployments).where(eq(schema.deployments.appSlug, app.slug));
  await db.delete(schema.apps).where(eq(schema.apps.id, app.id)); // env vars cascade
  await reloadCaddyFromDb();
  res.status(204).end();
});

router.post('/:slug/rotate-secret', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const appSecret = generateAppSecret();
  await db.update(schema.apps).set({ appSecret, updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  res.json({ appSecret, note: 'Redeploy the app for the new secret to take effect.' });
});

// ── provisioning ────────────────────────────────────────────────────────────────
router.post('/:slug/provision', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    const { app: updated, results } = await provisionApp(app);
    res.json({ message: 'Provisioned', app: serializeApp(updated), details: results });
  } catch (err) {
    res.status(500).json({ error: `Provisioning failed: ${err.message}` });
  }
});

// ── GitHub repo connect / disconnect ──────────────────────────────────────────────
async function connectRepoInternal(app, githubRepo, branch, repoPath) {
  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  const webhookSecret = generateWebhookSecret();
  const callbackUrl = `${scheme()}://${config.adminSubdomain}.${config.baseDomain}/webhooks/github`;
  const webhookId = await createWebhook(githubRepo, callbackUrl, webhookSecret);
  await db.update(schema.apps).set({
    githubRepo, branch: branch || 'main', repoPath: repoPath || '', webhookId, webhookSecret, updatedAt: new Date()
  }).where(eq(schema.apps.id, app.id));
}

router.post('/:slug/connect-repo', async (req, res) => {
  const { githubRepo, branch, repoPath } = req.body || {};
  if (!githubRepo) return res.status(400).json({ error: 'githubRepo is required (e.g. "owner/repo")' });
  if (!config.github.pat) return res.status(422).json({ error: 'GitHub PAT not configured (TOOLSTEAD_GITHUB_PAT)' });
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    await connectRepoInternal(app, githubRepo, branch, repoPath);
    res.json({ message: `Connected to ${githubRepo}`, app: serializeApp(await getAppBySlug(app.slug)) });
  } catch (err) {
    res.status(500).json({ error: `Failed to set up webhook: ${err.message}` });
  }
});

router.post('/:slug/disconnect-repo', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  await db.update(schema.apps).set({ githubRepo: '', webhookId: null, webhookSecret: '', updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  res.json({ message: 'Repository disconnected', app: serializeApp(await getAppBySlug(app.slug)) });
});

// ── deploys ───────────────────────────────────────────────────────────────────
router.post('/:slug/deploy', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    const deployment = await runDeploy(app, { trigger: req.auth?.type === 'token' ? 'cli' : 'manual' });
    res.json({ message: 'Deploy triggered', deploymentId: deployment.id });
  } catch (err) {
    if (err.status === 422 && err.missing) {
      return res.status(422).json({ error: err.message, missing: err.missing, deploymentId: err.deployment?.id });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:slug/deployments', async (req, res) => {
  const rows = await db.select({
    id: schema.deployments.id, appSlug: schema.deployments.appSlug, status: schema.deployments.status,
    trigger: schema.deployments.trigger, commitHash: schema.deployments.commitHash,
    commitMessage: schema.deployments.commitMessage, error: schema.deployments.error,
    startedAt: schema.deployments.startedAt, finishedAt: schema.deployments.finishedAt, createdAt: schema.deployments.createdAt
  }).from(schema.deployments).where(eq(schema.deployments.appSlug, req.params.slug)).orderBy(desc(schema.deployments.createdAt)).limit(20);
  res.json({ deployments: rows });
});

router.get('/:slug/deployments/:id', async (req, res) => {
  const rows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, req.params.id)).limit(1);
  const d = rows[0];
  if (!d || d.appSlug !== req.params.slug) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment: d });
});

// ── env vars ──────────────────────────────────────────────────────────────────
router.get('/:slug/env', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const envVars = await getAppEnvVars(app.id);
  res.json({ envVars: envVars.map(serializeEnvVar), missingRequired: computeMissingRequired(app, envVars) });
});

// Set a value (works for declared + reserved rows; creates an ad-hoc declared row if new).
router.put('/:slug/env/:key', async (req, res) => {
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  if (/^TOOLSTEAD_/.test(req.params.key)) {
    // only reserved rows the platform created (external mode) are settable
    const app = await getAppBySlug(req.params.slug);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
    if (!rows[0]) return res.status(400).json({ error: 'Reserved TOOLSTEAD_* variables cannot be declared by apps' });
    await db.update(schema.appEnvVars).set({ value, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, rows[0].id));
    return res.json({ ok: true });
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(req.params.key)) return res.status(400).json({ error: 'key must be UPPER_SNAKE_CASE' });

  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
  if (rows[0]) await db.update(schema.appEnvVars).set({ value, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, rows[0].id));
  else await db.insert(schema.appEnvVars).values({ appId: app.id, key: req.params.key, value, kind: 'declared' });
  res.json({ ok: true });
});

router.post('/:slug/env/bulk', async (req, res) => {
  const { raw } = req.body || {};
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'raw string is required' });
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const existing = await getAppEnvVars(app.id);
  const byKey = new Map(existing.map((r) => [r.key, r]));
  let added = 0; let skipped = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (!key || /^TOOLSTEAD_/.test(key) || !/^[A-Z][A-Z0-9_]*$/.test(key)) { skipped++; continue; }
    if (byKey.has(key)) await db.update(schema.appEnvVars).set({ value, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, byKey.get(key).id));
    else await db.insert(schema.appEnvVars).values({ appId: app.id, key, value, kind: 'declared' });
    added++;
  }
  res.json({ added, skipped });
});

router.delete('/:slug/env/:key', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'Env var not found' });
  if (rows[0].kind === 'reserved') return res.status(400).json({ error: 'Cannot delete a platform-required variable; change the resource mode instead' });
  await db.delete(schema.appEnvVars).where(eq(schema.appEnvVars.id, rows[0].id));
  res.status(204).end();
});

// ── process control ──────────────────────────────────────────────────────────────
router.get('/:slug/status', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(pc.appStatus(app));
});

router.post('/:slug/restart', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try { pc.restart(app); res.json({ message: 'Process restarted' }); }
  catch (err) { res.status(500).json({ error: `Restart failed: ${err.message}` }); }
});

router.post('/:slug/stop', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try { pc.stop(app); res.json({ message: 'Process stopped' }); }
  catch (err) { res.status(500).json({ error: `Stop failed: ${err.message}` }); }
});

router.get('/:slug/logs', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const lines = parseInt(req.query.lines, 10) || 100;
  res.json({ logs: pc.readLogs(app, lines) });
});

// ── terminal (gated behind TOOLSTEAD_ENABLE_TERMINAL; arbitrary RCE by design) ──
if (config.enableTerminal) {
  router.get('/:slug/exec', async (req, res) => {
    const command = req.query.command;
    if (!command || !command.trim()) return res.status(400).json({ error: 'command query parameter is required' });
    const app = await getAppBySlug(req.params.slug);
    if (!app) return res.status(404).json({ error: 'App not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const envVars = await getAppEnvVars(app.id);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: config.env, ...computeEnv(app, envVars) };
    const cwd = path.join(config.paths.apps, app.slug);
    const child = spawn('sh', ['-c', command], { cwd, env, timeout: 5 * 60 * 1000 });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    child.stdout.on('data', (c) => send('stdout', c.toString()));
    child.stderr.on('data', (c) => send('stderr', c.toString()));
    child.on('close', (code) => { send('exit', { code }); res.end(); });
    child.on('error', (err) => { send('error', err.message); res.end(); });
    req.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
  });
}

module.exports = router;
