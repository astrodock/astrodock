#!/usr/bin/env node
'use strict';

// Forked child process: performs a single deploy and records progress to the
// Deployment row. Branches on runtime.type (node buildpack vs Dockerfile).
// Receives { deploymentId, appSlug } as JSON in argv[2].

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema, close } = require('../db');
const { computeEnv, computeMissingRequired } = require('../lib/env-compute');

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 300000, ...opts }).trim();
}

async function run() {
  const { deploymentId, appSlug } = JSON.parse(process.argv[2]);

  const depRows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1);
  const appRows = await db.select().from(schema.apps).where(eq(schema.apps.slug, appSlug)).limit(1);
  const deployment = depRows[0];
  const app = appRows[0];
  if (!deployment || !app) { console.error('deployment or app not found'); process.exit(1); }

  const envVars = await db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, app.id));

  let log = '';
  let commitHash = deployment.commitHash || '';
  let commitMessage = deployment.commitMessage || '';

  async function appendLog(msg) {
    log += `[${new Date().toISOString()}] ${msg}\n`;
    await db.update(schema.deployments).set({ log }).where(eq(schema.deployments.id, deploymentId));
  }
  async function setStatus(status) {
    await db.update(schema.deployments).set({ status, log }).where(eq(schema.deployments.id, deploymentId));
  }

  try {
    // Re-run the gate defensively.
    const missing = computeMissingRequired(app, envVars);
    if (missing.length) throw new Error(`Missing required variables: ${missing.map((m) => m.key).join(', ')}`);

    const repoDir = path.join(config.paths.repos, app.slug);
    const repoUrl = `https://x-access-token:${config.github.pat}@github.com/${app.githubRepo}.git`;

    // 1. clone / pull
    await setStatus('cloning');
    fs.mkdirSync(config.paths.repos, { recursive: true });
    if (fs.existsSync(path.join(repoDir, '.git'))) {
      await appendLog(`Pulling ${app.githubRepo} (${app.branch})`);
      exec(`git -C "${repoDir}" fetch origin`);
      exec(`git -C "${repoDir}" reset --hard origin/${app.branch}`);
    } else {
      await appendLog(`Cloning ${app.githubRepo} (${app.branch})`);
      exec(`git clone --branch ${app.branch} --single-branch "${repoUrl}" "${repoDir}"`);
    }

    if (!commitHash) commitHash = exec(`git -C "${repoDir}" rev-parse --short HEAD`);
    if (!commitMessage) commitMessage = exec(`git -C "${repoDir}" log -1 --pretty=%s`);
    await db.update(schema.deployments).set({ commitHash, commitMessage }).where(eq(schema.deployments.id, deploymentId));
    await appendLog(`Commit ${commitHash} — ${commitMessage}`);

    const deployRoot = app.repoPath ? path.join(repoDir, app.repoPath) : repoDir;
    if (app.repoPath && !fs.existsSync(deployRoot)) {
      throw new Error(`repoPath "${app.repoPath}" does not exist in the repository`);
    }

    const env = computeEnv(app, envVars);

    if (app.runtimeType === 'docker') {
      await deployDocker(app, deployRoot, env, { appendLog, setStatus, commitHash });
    } else {
      await deployNode(app, deployRoot, env, { appendLog, setStatus });
    }

    // health probe (best-effort; failure marks the deploy failed)
    await setStatus('deploying');
    const healthy = await probe(app);
    await appendLog(healthy ? 'Health probe: app is responding' : 'Health probe: no response yet (app may still be starting)');

    await appendLog('Deploy complete');
    await db.update(schema.deployments).set({
      status: 'success', log, commitHash, commitMessage, finishedAt: new Date()
    }).where(eq(schema.deployments.id, deploymentId));
  } catch (err) {
    await appendLog(`ERROR: ${err.message}`);
    if (err.stderr) await appendLog(String(err.stderr));
    if (err.stdout) await appendLog(String(err.stdout));
    await db.update(schema.deployments).set({
      status: 'failed', error: err.message, log, finishedAt: new Date()
    }).where(eq(schema.deployments.id, deploymentId));
  } finally {
    await close().catch(() => {});
  }
  process.exit(0);
}

// ── Node buildpack ───────────────────────────────────────────────────────────
async function deployNode(app, deployRoot, env, { appendLog, setStatus }) {
  await setStatus('building');

  const hasApp = fs.existsSync(path.join(deployRoot, 'app'));
  const hasServer = fs.existsSync(path.join(deployRoot, 'server'));
  const standaloneServer = !hasApp && !hasServer && fs.existsSync(path.join(deployRoot, 'server.js'));
  const standaloneApp = !hasApp && !hasServer && !standaloneServer && fs.existsSync(path.join(deployRoot, 'package.json'));

  const appSrc = hasApp ? path.join(deployRoot, 'app') : (standaloneApp ? deployRoot : null);
  const serverSrc = hasServer ? path.join(deployRoot, 'server') : (standaloneServer ? deployRoot : null);
  if (!appSrc && !serverSrc) {
    await appendLog('WARNING: no app/ or server/ (or standalone server.js/package.json) found');
  }

  // frontend
  if (appSrc) {
    await appendLog('Installing frontend deps (npm ci)…');
    await appendLog(exec(`cd "${appSrc}" && npm ci 2>&1`) || 'deps installed');
    await appendLog(`Building frontend (${app.buildCommand})…`);
    await appendLog(exec(`cd "${appSrc}" && ${app.buildCommand} 2>&1`) || 'build complete');

    const distDir = path.join(appSrc, 'dist');
    const staticPath = path.join(config.paths.static, app.slug);
    if (fs.existsSync(distDir)) {
      fs.mkdirSync(staticPath, { recursive: true });
      await appendLog(`Syncing frontend → ${staticPath}`);
      exec(`rsync -a --delete "${distDir}/" "${staticPath}/"`);
    } else {
      await appendLog('WARNING: no dist/ after build');
    }
  }

  // server
  if (serverSrc) {
    await setStatus('deploying');
    const apiPath = path.join(config.paths.apps, app.slug);
    fs.mkdirSync(apiPath, { recursive: true });
    await appendLog(`Copying server → ${apiPath}`);
    exec(`rsync -a --delete --exclude='.env' --exclude='node_modules' "${serverSrc}/" "${apiPath}/"`);
    await appendLog('Installing server deps (npm ci --production)…');
    await appendLog(exec(`cd "${apiPath}" && npm ci --omit=dev 2>&1`) || 'server deps installed');

    // PM2 ecosystem with the computed env. Blank any platform-only TOOLSTEAD_*
    // that isn't part of this app's env so the runner's own secrets never leak.
    const ecosystemEnv = { ...env, NODE_ENV: config.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TOOLSTEAD_') && !(key in ecosystemEnv)) ecosystemEnv[key] = '';
    }

    // #1: run each Node app as its own non-root OS user so apps can't read each
    // other's secrets/code. The ecosystem file (which holds the env) is owned by
    // that user and not readable by other app users.
    const appUser = `tsapp_${app.slug.replace(/[^a-z0-9]/g, '_')}`;
    const haveUseradd = canUseradd();
    if (haveUseradd) {
      try { exec(`id -u ${appUser} >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin ${appUser}`); }
      catch (e) { await appendLog(`(note) could not create per-app user: ${e.message}`); }
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(apiPath, 'package.json'), 'utf8'));
    const ext = pkg.type === 'module' ? '.cjs' : '.js';
    const ecosystemPath = path.join(apiPath, `ecosystem.config${ext}`);
    const appCfg = { name: app.slug, script: 'server.js', cwd: apiPath, log_date_format: 'YYYY-MM-DD HH:mm:ss', env: ecosystemEnv };
    if (haveUseradd) { appCfg.uid = appUser; appCfg.gid = appUser; }
    fs.writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify({ apps: [appCfg] }, null, 2)};\n`);

    if (haveUseradd) {
      // own + lock down the app dir; secrets file is 600, code dir 700 — no cross-app reads
      try {
        exec(`chown -R ${appUser}:${appUser} "${apiPath}"`);
        exec(`chmod 700 "${apiPath}"`);
        exec(`chmod 600 "${ecosystemPath}"`);
      } catch (e) { await appendLog(`(note) could not lock down app dir: ${e.message}`); }
    }

    await appendLog(`(Re)starting PM2 process "${app.slug}"${haveUseradd ? ` as ${appUser}` : ''}`);
    try { exec(`pm2 delete ${app.slug} 2>&1`); } catch { /* not running yet */ }
    await appendLog(exec(`pm2 start "${ecosystemPath}" 2>&1`) || 'started');
    try { exec('pm2 save 2>&1'); } catch { /* ignore */ } // #5: persist for resurrect on restart
  }
}

let _useradd;
function canUseradd() {
  if (_useradd !== undefined) return _useradd;
  try { execSync('command -v useradd', { stdio: 'ignore' }); _useradd = true; }
  catch { _useradd = false; }
  return _useradd;
}

// ── Dockerfile (sibling container) ─────────────────────────────────────────────
async function deployDocker(app, deployRoot, env, { appendLog, setStatus, commitHash }) {
  await setStatus('building');
  const tag = `app-${app.slug}:${commitHash || 'latest'}`;
  const dockerfile = app.dockerfile || 'Dockerfile';

  await appendLog(`docker build -t ${tag} (${dockerfile})`);
  await appendLog(exec(`docker build -f "${path.join(deployRoot, dockerfile)}" -t "${tag}" "${deployRoot}" 2>&1`, { timeout: 600000 }) || 'build complete');

  await setStatus('deploying');
  // env-file (contains secrets) — written to the app's apps-dir, locked down
  const apiPath = path.join(config.paths.apps, app.slug);
  fs.mkdirSync(apiPath, { recursive: true });
  const envFile = path.join(apiPath, '.docker.env');
  const envText = Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n';
  fs.writeFileSync(envFile, envText, { mode: 0o600 });

  const name = `app-${app.slug}`;
  try { exec(`docker rm -f ${name} 2>&1`); } catch { /* not running */ }
  await appendLog(`docker run ${name} on network ${config.dockerNetwork}`);
  await appendLog(exec(
    `docker run -d --name ${name} --network ${config.dockerNetwork} --restart unless-stopped --env-file "${envFile}" "${tag}" 2>&1`
  ) || 'container started');
}

// ── health probe (unified) ─────────────────────────────────────────────────────
function probe(app) {
  const http = require('http');
  const host = app.runtimeType === 'docker' ? `app-${app.slug}` : 'localhost';
  return new Promise((resolve) => {
    const req = http.get({ host, port: app.port, path: '/health', timeout: 5000 }, (res) => {
      res.resume();
      resolve(true); // any HTTP response means the process is up
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

run().catch((err) => { console.error('deploy worker crashed:', err); process.exit(1); });
