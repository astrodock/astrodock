'use strict';

// The runner service. Runs in its OWN container that holds the Docker socket, the
// GitHub PAT, PM2, and the build/clone volumes — so the control-plane (api)
// container holds none of those. The api calls these endpoints over the internal
// network, authenticated with a shared token. See DECISIONS.md (#9 / B1).

const express = require('express');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { runDeploy } = require('./deploy');
const pc = require('./process-control');
const { provisionStorage, dropStorage } = require('../provision/storage');
const { startHealthChecker } = require('./health');
const { runBackup, startBackupScheduler } = require('../lib/backups');

const app = express();

// Shared-secret auth between api ↔ runner.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!config.runnerToken || tok !== config.runnerToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'astrodock-runner' }));

async function loadApp(slug) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, slug)).limit(1);
  return rows[0] || null;
}

function handleDeployError(res, err) {
  if (err.status === 422 && err.missing) return res.status(422).json({ error: err.message, missing: err.missing, deploymentId: err.deployment?.id });
  return res.status(err.status || 500).json({ error: err.message });
}

// Deploy from the connected GitHub repo.
app.post('/deploy', express.json(), async (req, res) => {
  const a = await loadApp(req.body?.appSlug);
  if (!a) return res.status(404).json({ error: 'App not found' });
  try {
    const d = await runDeploy(a, { trigger: req.body.trigger || 'manual', commitHash: req.body.commitHash, commitMessage: req.body.commitMessage, targetCommit: req.body.targetCommit });
    res.json({ deploymentId: d.id });
  } catch (err) { handleDeployError(res, err); }
});

// Local deploy: raw gzipped tarball body, ?slug=.
app.post('/deploy-local', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  const a = await loadApp(req.query.slug);
  if (!a) return res.status(404).json({ error: 'App not found' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(config.paths.repos, { recursive: true });
  const tarPath = path.join(config.paths.repos, `${a.slug}.upload.tgz`);
  fs.writeFileSync(tarPath, req.body);
  try {
    const d = await runDeploy(a, { trigger: 'cli', localTarball: tarPath });
    res.json({ deploymentId: d.id });
  } catch (err) { handleDeployError(res, err); }
});

// Provision a per-app scoped storage identity (needs the Docker socket → weed shell).
app.post('/provision-storage', express.json(), async (req, res) => {
  const a = await loadApp(req.body?.appSlug);
  if (!a) return res.status(404).json({ error: 'App not found' });
  try { res.json(await provisionStorage(a)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/drop-storage', express.json(), async (req, res) => {
  const a = await loadApp(req.body?.appSlug);
  if (!a) return res.json({ ok: true });
  try { await dropStorage(a); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Process control.
app.get('/apps/:slug/status', async (req, res) => {
  const a = await loadApp(req.params.slug);
  if (!a) return res.status(404).json({ error: 'App not found' });
  res.json(pc.appStatus(a));
});
app.post('/apps/:slug/restart', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  try { pc.restart(a); res.json({ message: 'restarted' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/apps/:slug/stop', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  try { pc.stop(a); res.json({ message: 'stopped' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/apps/:slug/remove', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.json({ ok: true });
  try { pc.remove(a); } catch { /* gone */ }
  res.json({ ok: true });
});
app.get('/apps/:slug/logs', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  res.json({ logs: pc.readLogs(a, parseInt(req.query.lines, 10) || 100) });
});
app.get('/apps/status-all', async (req, res) => {
  const apps = await db.select().from(schema.apps);
  res.json({ statuses: pc.statusAll(apps) });
});

// What ports this host publishes to the world. Lives on the runner because only
// the runner holds the Docker socket. Read-only: see runner/exposure.js for why
// Astrodock reports on the firewall rather than managing it.
app.get('/exposure', async (req, res) => {
  const e = require('./exposure');
  const [ports, metadata] = await Promise.all([e.checkExposure(), e.checkMetadataReachable()]);
  res.json({ ...ports, metadata });
});

// Structured operations on an app's deployed files — what the removed terminal was
// used for, as named actions. Lives on the runner because that is where the app's
// files and process actually are; the API container never had them.
app.get('/apps/:slug/ops/list', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  try { res.json({ entries: require('./app-ops').listDirectory(a.slug, req.query.path || '.') }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/apps/:slug/ops/file', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  try { res.json(require('./app-ops').readFile(a.slug, req.query.path)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/apps/:slug/ops/env', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  const vars = await db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, a.id));
  res.json({ env: require('./app-ops').runtimeEnv(a, vars) });
});
app.get('/apps/:slug/ops/commands', async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  res.json({ commands: require('./app-ops').declaredCommands(a) });
});
app.post('/apps/:slug/ops/run', express.json(), async (req, res) => {
  const a = await loadApp(req.params.slug); if (!a) return res.status(404).json({ error: 'App not found' });
  const vars = await db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, a.id));
  try { res.json(await require('./app-ops').runDeclared(a, vars, req.body?.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Trigger a backup on demand (the api proxies POST /admin/backups here).
app.post('/backup', express.json(), async (req, res) => {
  const result = await runBackup({ trigger: req.body?.trigger || 'manual' });
  res.status(result.ok ? 200 : 500).json(result);
});

// Read a dump back out. The file lives on the runner's volume, so the api
// streams it through from here rather than mounting the volume itself.
app.get('/backup/:id/file', async (req, res) => {
  const backups = require('../lib/backups');
  try {
    const { row, file } = await backups.findBackup(req.params.id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(row.sizeBytes || 0));
    res.setHeader('Content-Disposition', `attachment; filename="${require('path').basename(file)}"`);
    require('fs').createReadStream(file).pipe(res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Accept a dump someone is carrying back in.
app.post('/backup/upload', express.raw({ type: '*/*', limit: '2gb' }), async (req, res) => {
  const backups = require('../lib/backups');
  try { res.json(await backups.saveUploadedBackup(req.body, { actor: req.query.actor })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Overwrite the live database. Only the runner can do this — the api would be
// dropping the database it is answering from — and the api is restarted after,
// once this response is safely out the door.
app.post('/backup/:id/restore', express.json(), async (req, res) => {
  const backups = require('../lib/backups');
  try {
    const result = await backups.restoreBackup({ id: req.params.id, actor: req.body?.actor });
    res.json(result);
    backups.restartApiSoon();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, safetyBackup: err.safetyBackup });
  }
});

// The base domain can change at runtime (first-run wizard, or an operator moving
// domains later), and this process renders hostnames for health probes and env
// injection. It has no way to be notified, so it re-reads the stored value on an
// interval — the same eventual-consistency approach settings.js already uses for
// its 15s cache. Cheap: one indexed select per pass.
const BOOTSTRAP_REFRESH_MS = 60_000;

async function start() {
  const { applyBootstrapSettings } = require('../lib/settings');
  await applyBootstrapSettings().catch(() => {});
  setInterval(() => { applyBootstrapSettings().catch(() => {}); }, BOOTSTRAP_REFRESH_MS).unref();
  startHealthChecker(); // the runner owns app health (it can probe + read pm2/docker)
  startBackupScheduler(); // the runner owns the Docker socket + backups volume
  app.listen(config.runnerPort, () => console.log(`Astrodock runner listening on :${config.runnerPort}`));
}

module.exports = { app, start };

if (require.main === module) {
  start().catch((err) => { console.error('Failed to start runner:', err); process.exit(1); });
}
