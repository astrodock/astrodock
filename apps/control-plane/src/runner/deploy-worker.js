#!/usr/bin/env node
'use strict';

// Forked child process: performs a single deploy and records progress to the
// Deployment row. Branches on runtime.type (node buildpack vs Dockerfile).
// Receives { deploymentId, appSlug } as JSON in argv[2].

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema, close } = require('../db');
const { computeEnv, computeMissingRequired } = require('../lib/env-compute');
const { emitEvent } = require('../lib/events');

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: config.deploy.buildTimeoutMs, ...opts }).trim();
}

async function run() {
  const { deploymentId, appSlug, localTarball, targetCommit } = JSON.parse(process.argv[2]);

  const depRows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1);
  const appRows = await db.select().from(schema.apps).where(eq(schema.apps.slug, appSlug)).limit(1);
  const deployment = depRows[0];
  const app = appRows[0];
  if (!deployment || !app) { console.error('deployment or app not found'); process.exit(1); }

  const envVars = await db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, app.id));

  let log = '';
  let commitHash = deployment.commitHash || '';
  let commitMessage = deployment.commitMessage || '';

  // Never let the GitHub token reach the stored log (raw, in a URL, or base64 in an auth header).
  function redact(s) {
    let out = String(s);
    if (config.github.pat) {
      out = out.split(config.github.pat).join('***');
      const b64 = Buffer.from(`x-access-token:${config.github.pat}`).toString('base64');
      out = out.split(b64).join('***');
    }
    out = out.replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
    out = out.replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: Basic ***');
    return out;
  }
  const LOG_MAX = 256 * 1024; // cap stored deploy logs so a noisy build can't bloat the row
  async function appendLog(msg) {
    log += `[${new Date().toISOString()}] ${redact(msg)}\n`;
    if (log.length > LOG_MAX) log = '…[earlier build output truncated]\n' + log.slice(log.length - LOG_MAX);
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
    fs.mkdirSync(config.paths.repos, { recursive: true });

    // 1. source: extract a local upload, or clone/pull from GitHub
    await setStatus('cloning');
    if (localTarball) {
      await appendLog('Extracting local upload');
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(repoDir, { recursive: true });
      exec(`tar xzf "${localTarball}" -C "${repoDir}"`);
      try { fs.rmSync(localTarball, { force: true }); } catch { /* ignore */ }
      commitHash = commitHash || 'local';
      commitMessage = commitMessage || 'local upload';
    } else {
      // Pass the token via a per-invocation auth header (-c http.extraHeader) and keep the
      // stored remote tokenless, so the PAT is never written to <repo>/.git/config on disk.
      const tokenlessUrl = `https://github.com/${app.githubRepo}.git`;
      const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${config.github.pat}`).toString('base64')}`;
      const gitAuth = `git -c http.extraHeader="${authHeader}"`;
      if (fs.existsSync(path.join(repoDir, '.git'))) {
        await appendLog(`Pulling ${app.githubRepo} (${app.branch})`);
        exec(`${gitAuth} -C "${repoDir}" fetch origin`);
      } else {
        await appendLog(`Cloning ${app.githubRepo} (${app.branch})`);
        fs.rmSync(repoDir, { recursive: true, force: true });
        exec(`${gitAuth} clone --branch "${app.branch}" --single-branch "${tokenlessUrl}" "${repoDir}"`);
        exec(`${gitAuth} -C "${repoDir}" fetch origin`); // ensure rollback target commits are present
      }
      if (targetCommit) {
        // Rollback / pinned deploy: check out the requested commit instead of branch HEAD.
        await appendLog(`Rolling back to commit ${targetCommit}`);
        exec(`git -C "${repoDir}" reset --hard "${targetCommit}"`);
      } else {
        exec(`git -C "${repoDir}" reset --hard "origin/${app.branch}"`);
      }
      if (!commitHash) commitHash = exec(`git -C "${repoDir}" rev-parse --short HEAD`);
      if (!commitMessage) commitMessage = exec(`git -C "${repoDir}" log -1 --pretty=%s`);
    }
    await db.update(schema.deployments).set({ commitHash, commitMessage }).where(eq(schema.deployments.id, deploymentId));
    await appendLog(`Commit ${commitHash} — ${commitMessage}`);

    const deployRoot = app.repoPath ? path.join(repoDir, app.repoPath) : repoDir;
    if (app.repoPath && !fs.existsSync(deployRoot)) {
      throw new Error(`repoPath "${app.repoPath}" does not exist in the repository`);
    }

    // This runs in a FORKED, detached process. The api and the runner server each
    // hydrate the stored base domain at startup; this one never did, so it
    // computed every app's environment with config.baseDomain === ''.
    //
    // Only visible when the domain came from the setup wizard — an install that
    // sets ASTRODOCK_BASE_DOMAIN in .env looks fine, which is why an audit of the
    // environment catalogue run in-process did not find it. The symptoms were an
    // empty ASTRODOCK_BASE_DOMAIN, an ASTRODOCK_APP_URL truncated to
    // "https://<slug>.", and — worst — no ASTRODOCK_AUTHORIZE_URL at all, because
    // env-compute only sets it when a domain is configured. Apps then fell back to
    // the internal address, silently reinstating the exact bug v0.0.15 fixed.
    await require('../lib/settings').applyBootstrapSettings().catch(() => {});

    const env = computeEnv(app, envVars);

    if (app.runtimeType === 'docker') {
      await deployDocker(app, deployRoot, env, { appendLog, setStatus, commitHash });
    } else {
      await deployNode(app, deployRoot, env, { appendLog, setStatus });
    }

    // health probe (best-effort; failure marks the deploy failed)
    await setStatus('deploying');
    const healthy = await probe(app);
    await appendLog(healthy
      ? 'Health probe: app is responding'
      : `Health probe: no response after ${PROBE_ATTEMPTS}s — the app may still be starting, or it is not listening on ASTRODOCK_PORT`);

    await appendLog('Deploy complete');
    await db.update(schema.deployments).set({
      status: 'success', log, commitHash, commitMessage, finishedAt: new Date()
    }).where(eq(schema.deployments.id, deploymentId));
    // Awaited (not fire-and-forget): this is a short-lived process that closes the
    // DB pool and exits below, so delivery must finish first.
    await emitEvent({
      category: 'deploy', type: 'deploy.succeeded', severity: 'info',
      appSlug: app.slug, targetType: 'app', targetId: app.slug,
      message: `Deploy of ${app.name} succeeded (${commitHash})`,
      meta: { commitHash, commitMessage, trigger: deployment.trigger, deploymentId }
    }).catch(() => {});
  } catch (err) {
    await appendLog(`ERROR: ${err.message}`);
    if (err.stderr) await appendLog(String(err.stderr));
    if (err.stdout) await appendLog(String(err.stdout));
    await db.update(schema.deployments).set({
      status: 'failed', error: redact(err.message), log, finishedAt: new Date()
    }).where(eq(schema.deployments.id, deploymentId));
    await emitEvent({
      category: 'deploy', type: 'deploy.failed', severity: 'critical',
      appSlug: app.slug, targetType: 'app', targetId: app.slug,
      message: `Deploy of ${app.name} failed: ${redact(err.message)}`,
      meta: { commitHash, commitMessage, trigger: deployment.trigger, deploymentId }
    }).catch(() => {});
  } finally {
    await close().catch(() => {});
  }
  process.exit(0);
}

// ── Node buildpack ───────────────────────────────────────────────────────────
async function deployNode(app, deployRoot, env, { appendLog, setStatus }) {
  await setStatus('building');

  const repoDir = path.join(config.paths.repos, app.slug);
  const hasApp = fs.existsSync(path.join(deployRoot, 'app'));
  const hasServer = fs.existsSync(path.join(deployRoot, 'server'));
  const standaloneServer = !hasApp && !hasServer && fs.existsSync(path.join(deployRoot, 'server.js'));
  const standaloneApp = !hasApp && !hasServer && !standaloneServer && fs.existsSync(path.join(deployRoot, 'package.json'));

  const appSrc = hasApp ? path.join(deployRoot, 'app') : (standaloneApp ? deployRoot : null);
  const serverSrc = hasServer ? path.join(deployRoot, 'server') : (standaloneServer ? deployRoot : null);
  if (!appSrc && !serverSrc) {
    await appendLog('WARNING: no app/ or server/ (or standalone server.js/package.json) found');
  }

  // Per-app non-root identity. Build, install (incl. npm lifecycle scripts), and the
  // runtime process ALL run as this user so a malicious app can neither read the
  // platform secrets nor reach another app's files. Created before any app code runs.
  const appUser = `tsapp_${app.slug.replace(/[^a-z0-9]/g, '_')}`;
  const haveUseradd = canUseradd();
  let ids = null;
  if (haveUseradd) {
    try {
      exec(`id -u ${appUser} >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin ${appUser}`);
      ids = { uid: parseInt(exec(`id -u ${appUser}`), 10), gid: parseInt(exec(`id -g ${appUser}`), 10) };
    } catch (e) { await appendLog(`(note) per-app user unavailable, building as runner user: ${e.message}`); }
  }

  // Losing the per-app user is a security downgrade, not a footnote. Build and
  // install commands come from the repo and from app.buildCommand, so without it
  // they run as the runner process user — inside a container holding the Docker
  // socket. That was a line in a deploy log nobody reads; it is now an event, so
  // it reaches Activity and whatever notification rules exist.
  if (!ids) {
    await appendLog('WARNING: building WITHOUT a per-app user — app build commands run with the runner\'s own privileges.');
    require('../lib/events').emitEvent({
      category: 'system', type: 'deploy.unsandboxed_build', severity: 'critical',
      targetType: 'app', targetId: app.slug,
      message: `Built "${app.slug}" without a per-app user — its build commands ran with the runner's privileges`,
      meta: { app: app.slug, useraddAvailable: haveUseradd },
      dedupeKey: `deploy:unsandboxed:${app.slug}`, dedupeWindowMs: 6 * 3600 * 1000
    }).catch(() => {});
  }

  // The build env is the app's OWN computed env ONLY (no platform stack secrets like
  // the Postgres superuser pw, object-store master key, or ASTRODOCK_SECRET_KEY — those
  // live in process.env but must never reach app build/install code). npm cache → app HOME.
  const appHome = path.join(config.paths.apps, `${app.slug}.home`);
  fs.mkdirSync(appHome, { recursive: true });
  if (ids) { try { exec(`chown -R ${appUser}:${appUser} "${appHome}"`); exec(`chmod 700 "${appHome}"`); } catch { /* best effort */ } }
  const buildEnv = { PATH: process.env.PATH, HOME: appHome, NODE_ENV: config.env, npm_config_cache: path.join(appHome, '.npm'), ...env };

  // npm ci needs a lockfile; fall back to npm install when there isn't one
  const installCmd = (dir, prod) => {
    const ci = fs.existsSync(path.join(dir, 'package-lock.json'));
    // --include=dev is not redundant: the build env sets NODE_ENV=production (apps
    // need it at runtime), and npm honours that by skipping devDependencies even
    // when you did not ask it to. A frontend with its build tool in
    // devDependencies — which is where vite, esbuild and tsc normally live — then
    // failed with "vite: not found". Say which one is wanted so the environment
    // cannot decide it for us.
    return ci
      ? `npm ci${prod ? ' --omit=dev' : ' --include=dev'}`
      : `npm install${prod ? ' --omit=dev' : ' --include=dev'}`;
  };
  // Run an app-supplied command (install/build) as the unprivileged app user, with the
  // scrubbed build env. execFileSync({uid,gid}) avoids any su/shell-quoting pitfalls.
  function runAsApp(cwd, command) {
    return execFileSync('sh', ['-c', command], { encoding: 'utf8', timeout: 300000, cwd, env: buildEnv, ...(ids || {}) });
  }

  // the app user must own the build tree it writes into
  if (ids) { try { exec(`chown -R ${appUser}:${appUser} "${repoDir}"`); } catch { /* best effort */ } }

  // Set when a built frontend is staged and waiting to go live; called once the
  // server side has actually started, so the two halves change over together.
  let publishFrontend = null;

  // frontend
  if (appSrc) {
    await appendLog('Installing frontend deps…');
    await appendLog(runAsApp(appSrc, `${installCmd(appSrc, false)} 2>&1`) || 'deps installed');
    await appendLog(`Building frontend (${app.buildCommand})…`);
    await appendLog(runAsApp(appSrc, `${app.buildCommand} 2>&1`) || 'build complete');

    const distDir = path.join(appSrc, 'dist');
    const staticPath = path.join(config.paths.static, app.slug);
    if (fs.existsSync(distDir)) {
      // Build into a staging directory, don't publish it yet. The frontend used to
      // land here directly, several minutes before the server was restarted — so a
      // failure anywhere in between left the new UI live against the old API, with
      // nothing anywhere saying the two halves had come apart. Now the swap happens
      // after the server is up, below.
      const incoming = `${staticPath}.incoming`;
      exec(`rm -rf "${incoming}"`);
      fs.mkdirSync(incoming, { recursive: true });
      await appendLog(`Staging frontend → ${staticPath}`);
      exec(`rsync -a --delete "${distDir}/" "${incoming}/"`);
      publishFrontend = () => {
        const old = `${staticPath}.previous`;
        exec(`rm -rf "${old}"`);
        if (fs.existsSync(staticPath)) exec(`mv "${staticPath}" "${old}"`);
        exec(`mv "${incoming}" "${staticPath}"`); // root → static (served publicly)
        exec(`rm -rf "${old}"`);
      };
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
    if (ids) { try { exec(`chown -R ${appUser}:${appUser} "${apiPath}"`); } catch { /* best effort */ } }
    await appendLog('Installing server deps…');
    await appendLog(runAsApp(apiPath, `${installCmd(apiPath, true)} 2>&1`) || 'server deps installed');

    // PM2 ecosystem with the RUNTIME env. Blank any platform-only ASTRODOCK_* not in the
    // app's env so the runner's own secrets never leak into the running process either.
    const ecosystemEnv = { ...env, NODE_ENV: config.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ASTRODOCK_') && !(key in ecosystemEnv)) ecosystemEnv[key] = '';
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(apiPath, 'package.json'), 'utf8'));
    const ext = pkg.type === 'module' ? '.cjs' : '.js';
    const ecosystemPath = path.join(apiPath, `ecosystem.config${ext}`);
    const appCfg = { name: app.slug, script: 'server.js', cwd: apiPath, log_date_format: 'YYYY-MM-DD HH:mm:ss', env: ecosystemEnv };
    if (ids) { appCfg.uid = appUser; appCfg.gid = appUser; }
    fs.writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify({ apps: [appCfg] }, null, 2)};\n`);

    if (ids) {
      // lock down: secrets file 600, dirs 700, all owned by the app user — no cross-app reads
      try {
        exec(`chown ${appUser}:${appUser} "${ecosystemPath}"`);
        exec(`chmod 700 "${apiPath}" "${repoDir}"`);
        exec(`chmod 600 "${ecosystemPath}"`);
      } catch (e) { await appendLog(`(note) could not lock down app dir: ${e.message}`); }
    }

    await appendLog(`(Re)starting PM2 process "${app.slug}"${ids ? ` as ${appUser}` : ''}`);
    try { exec(`pm2 delete ${app.slug} 2>&1`); } catch { /* not running yet */ }
    await appendLog(exec(`pm2 start "${ecosystemPath}" 2>&1`) || 'started');
    try { exec('pm2 save 2>&1'); } catch { /* ignore */ } // #5: persist for resurrect on restart
  } else if (ids) {
    try { exec(`chmod 700 "${repoDir}"`); } catch { /* best effort */ }
  }

  // Everything that could fail has now run. Put the new frontend live.
  if (publishFrontend) {
    await appendLog('Publishing frontend');
    publishFrontend();
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
  await appendLog(exec(`docker build -f "${path.join(deployRoot, dockerfile)}" -t "${tag}" "${deployRoot}" 2>&1`, { timeout: config.deploy.dockerBuildTimeoutMs }) || 'build complete');

  await setStatus('deploying');
  // env-file (contains secrets) — written to the app's apps-dir, locked down
  const apiPath = path.join(config.paths.apps, app.slug);
  fs.mkdirSync(apiPath, { recursive: true });
  const envFile = path.join(apiPath, '.docker.env');
  const envText = Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n';
  fs.writeFileSync(envFile, envText, { mode: 0o600 });

  const name = `app-${app.slug}`;
  // Ask Docker which network we are on rather than trusting a configured name —
  // see runner/network.js. Getting this wrong produces an app that starts fine and
  // then cannot reach its own database.
  const network = await require('./network').resolveDockerNetwork();
  try { exec(`docker rm -f ${name} 2>&1`); } catch { /* not running */ }
  await appendLog(`docker run ${name} on network ${network}`);
  await appendLog(exec(
    `docker run -d --name ${name} --network ${network} --restart unless-stopped --env-file "${envFile}" "${tag}" 2>&1`
  ) || 'container started');
}

// ── health probe (unified) ─────────────────────────────────────────────────────
// Give the app a moment to bind before deciding it is not there.
//
// This used to fire once, immediately after the process was started, so a healthy
// app that took a second to listen was reported as "no response yet" — which is
// to say: almost always. The line was there to reassure, and instead it made
// every successful deploy look doubtful.
const PROBE_ATTEMPTS = 10;
const PROBE_GAP_MS = 1000;

function probeOnce(app) {
  const http = require('http');
  const host = app.runtimeType === 'docker' ? `app-${app.slug}` : 'localhost';
  return new Promise((resolve) => {
    const req = http.get({ host, port: app.port, path: '/health', timeout: 3000 }, (res) => {
      res.resume();
      resolve(true); // any HTTP response means the process is up
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function probe(app) {
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (await probeOnce(app)) return true;
    if (i < PROBE_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
  }
  return false;
}

run().catch((err) => { console.error('deploy worker crashed:', err); process.exit(1); });
