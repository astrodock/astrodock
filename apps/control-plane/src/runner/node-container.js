'use strict';

// Node buildpack apps in a container of their own (ASTRODOCK_NODE_RUNTIME=container).
//
// Under PM2 an app's build scripts and its server ran inside the runner, the
// container that holds the Docker socket and the GitHub PAT, kept apart from
// them by Unix users alone. Here neither does:
//
//   build    A throwaway container from the platform image, on Docker's default
//            bridge network: the internet for npm, nothing of the platform's.
//            Install and build run as uid 1000 with the app's own environment,
//            read from a file that is deleted before anything runs.
//   image    The finished build container, committed as app-<slug>:<commit>.
//   runtime  That image, on the platform network so it can reach its database,
//            with memory, CPU and process caps (lib/isolation), no capabilities,
//            and its environment from a 0600 file.
//
// The frontend is copied out of the build container and served by Caddy as
// before, so the layout an app uses (app/, server/, or a single package) is the
// same either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { dockerLimitArgs, limitsFor } = require('../lib/isolation');
const { selfImage } = require('./containers');

// The uid the app's code runs as, in the build and at runtime. 1000 is the
// `node` user in the platform image.
const APP_UID = 1000;

function docker(args, { timeout = 60000 } = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Single-quoted for sh. Used only for the env file the build sources.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Which folders hold the frontend and the server, relative to the deploy root. */
function layout(deployRoot) {
  const has = (p) => fs.existsSync(path.join(deployRoot, p));
  const hasApp = has('app');
  const hasServer = has('server');
  const standaloneServer = !hasApp && !hasServer && has('server.js');
  const standaloneApp = !hasApp && !hasServer && !standaloneServer && has('package.json');
  return {
    appRel: hasApp ? 'app' : (standaloneApp ? '.' : null),
    serverRel: hasServer ? 'server' : (standaloneServer ? '.' : null)
  };
}

function installCmd(deployRoot, rel, prod) {
  const ci = fs.existsSync(path.join(deployRoot, rel, 'package-lock.json'));
  // --include=dev for the frontend for the reason given in deploy-worker.js:
  // NODE_ENV=production would otherwise skip the build tool.
  return `${ci ? 'npm ci' : 'npm install'} ${prod ? '--omit=dev' : '--include=dev'}`;
}

/** The two scripts the build container runs: root's preparation, then the app's build. */
function buildScripts({ appRel, serverRel, buildCommand, installs }) {
  const root = [
    'set -e',
    // The environment arrives as a file so it never becomes part of the
    // container's configuration, which `docker commit` would keep.
    'set -a; . /tmp/astrodock-build.env; set +a',
    'rm -f /tmp/astrodock-build.env',
    `mkdir -p /home/node && chown -R ${APP_UID}:${APP_UID} /src /home/node`,
    `exec setpriv --reuid=${APP_UID} --regid=${APP_UID} --clear-groups sh /tmp/astrodock-build.sh`
  ].join('\n') + '\n';
  const steps = ['set -e'];
  if (appRel) {
    steps.push(`cd /src/${appRel}`, 'echo "Installing frontend deps…"', installs.app,
      `echo "Building frontend (${buildCommand.replace(/"/g, '\\"')})…"`, buildCommand);
  }
  if (serverRel) {
    // A .env in the repository must not shadow the environment the platform sets.
    steps.push(`cd /src/${serverRel}`, 'rm -f .env', 'echo "Installing server deps…"', installs.server);
  }
  return { root, build: steps.join('\n') + '\n' };
}

async function deployNodeContainer(app, deployRoot, env, { appendLog, setStatus, commitHash }) {
  await setStatus('building');
  const { appRel, serverRel } = layout(deployRoot);
  if (!appRel && !serverRel) await appendLog('WARNING: no app/ or server/ (or standalone server.js/package.json) found');

  const base = selfImage() || 'node:22-bookworm-slim';
  const build = `build-${app.slug}`;
  const tag = `app-${app.slug}:${commitHash || 'latest'}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `astrodock-${app.slug}-`));

  const installs = {
    app: appRel ? installCmd(deployRoot, appRel, false) : '',
    server: serverRel ? installCmd(deployRoot, serverRel, true) : ''
  };
  const scripts = buildScripts({ appRel, serverRel, buildCommand: app.buildCommand || 'npm run build', installs });
  const buildEnv = { ...env, NODE_ENV: config.env, HOME: '/home/node', npm_config_cache: '/home/node/.npm' };
  fs.writeFileSync(path.join(work, 'astrodock-build.env'),
    Object.entries(buildEnv).map(([k, v]) => `${k}=${shq(v ?? '')}`).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(work, 'astrodock-root.sh'), scripts.root, { mode: 0o644 });
  fs.writeFileSync(path.join(work, 'astrodock-build.sh'), scripts.build, { mode: 0o644 });

  // A build gets more memory than the app it builds: bundlers are hungry. Still capped.
  const caps = limitsFor(app);
  const buildMb = Math.min(Math.max(caps.memoryMb, 2048), caps.max.memoryMb);

  try {
    try { docker(['rm', '-f', build]); } catch { /* none left over */ }
    await appendLog(`Building in a container of its own (from ${base.slice(0, 19)})`);
    docker(['create', '--name', build,
      '--network', 'bridge',
      '--memory', `${buildMb}m`, '--memory-swap', `${buildMb}m`, '--cpus', (caps.cpuMillis / 1000).toFixed(2),
      '--pids-limit', '4096', '--security-opt', 'no-new-privileges',
      // Enough to hand the tree to uid 1000 and switch to it, and nothing else.
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
      '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--label', `astrodock.build=${app.slug}`,
      '--entrypoint', 'sh', base, '/tmp/astrodock-root.sh']);
    docker(['cp', `${deployRoot}/.`, `${build}:/src`], { timeout: config.deploy.buildTimeoutMs });
    for (const f of ['astrodock-build.env', 'astrodock-root.sh', 'astrodock-build.sh']) {
      docker(['cp', path.join(work, f), `${build}:/tmp/${f}`]);
    }

    const run = spawnSync('docker', ['start', '-a', build], {
      encoding: 'utf8', timeout: config.deploy.buildTimeoutMs * 2, maxBuffer: 16 * 1024 * 1024
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
    if (output) await appendLog(output.slice(-64 * 1024));
    const exitCode = parseInt(docker(['inspect', build, '--format', '{{.State.ExitCode}}']), 10);
    if (run.error) throw new Error(`build did not finish: ${run.error.message}`);
    if (exitCode !== 0) throw new Error(`build failed (exit ${exitCode})`);

    // Frontend: out of the container and into a staging folder. Links are dropped
    // on the way, as they are for PM2 apps: Caddy serves this from its own
    // container, where a link could reach its certificates.
    let publishFrontend = null;
    if (appRel) {
      const outDir = path.join(work, 'dist');
      try {
        docker(['cp', `${build}:/src/${appRel}/dist`, outDir]);
      } catch {
        await appendLog('WARNING: no dist/ after build');
      }
      // `docker cp` copies a link as a link, so a dist/ that is a symlink lands
      // here as one, pointing into the runner's own disk: /data/apps holds every
      // app's env file. Only a real directory, wholly inside the work folder, is
      // published. Links inside it are dropped by rsync below.
      let realDist = null;
      try {
        const st = fs.lstatSync(outDir);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          const r = fs.realpathSync(outDir);
          if (r.startsWith(fs.realpathSync(work) + path.sep)) realDist = r;
        }
      } catch { realDist = null; }
      if (fs.existsSync(outDir) && !realDist) {
        throw new Error('dist/ is a link, not a folder. Build output has to be a real folder inside the app.');
      }
      if (realDist) {
        const staticPath = path.join(config.paths.static, app.slug);
        const incoming = `${staticPath}.incoming`;
        fs.rmSync(incoming, { recursive: true, force: true });
        fs.mkdirSync(incoming, { recursive: true });
        execFileSync('rsync', ['-a', '--no-links', '--no-owner', '--no-group', '--delete', `${realDist}/`, `${incoming}/`]);
        publishFrontend = () => {
          const old = `${staticPath}.previous`;
          fs.rmSync(old, { recursive: true, force: true });
          if (fs.existsSync(staticPath)) fs.renameSync(staticPath, old);
          fs.renameSync(incoming, staticPath);
          fs.rmSync(old, { recursive: true, force: true });
        };
        await appendLog(`Staging frontend → ${staticPath}`);
      }
    }

    if (serverRel) {
      await setStatus('deploying');
      docker(['commit',
        '--change', 'ENTRYPOINT []',
        '--change', 'CMD ["node","server.js"]',
        '--change', `WORKDIR /src/${serverRel === '.' ? '' : serverRel}`,
        '--change', `USER ${APP_UID}:${APP_UID}`,
        build, tag], { timeout: 300000 });
      await appendLog(`Image ${tag}`);

      const apiPath = path.join(config.paths.apps, app.slug);
      fs.mkdirSync(apiPath, { recursive: true, mode: 0o700 });
      const envFile = path.join(apiPath, '.docker.env');
      fs.rmSync(envFile, { force: true });
      const runtimeEnv = { ...env, NODE_ENV: config.env };
      fs.writeFileSync(envFile, Object.entries(runtimeEnv)
        .map(([k, v]) => `${k}=${String(v ?? '').replace(/\n/g, ' ')}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });

      const name = `app-${app.slug}`;
      const network = await require('./network').resolveDockerNetwork();
      try { docker(['rm', '-f', name]); } catch { /* not running */ }
      await appendLog(`docker run ${name} on network ${network} (${caps.memoryMb} MB, ${(caps.cpuMillis / 1000).toFixed(2)} CPU)`);
      docker(['run', '-d', '--name', name, '--network', network, '--restart', 'unless-stopped', '--init',
        ...dockerLimitArgs(app),
        '--pids-limit', '1024', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
        '--label', `astrodock.app=${app.slug}`,
        '--env-file', envFile, tag]);
    }

    if (publishFrontend) {
      await appendLog('Publishing frontend');
      publishFrontend();
    }
    return { hasServer: !!serverRel };
  } finally {
    try { docker(['rm', '-f', build]); } catch { /* already gone */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Ask the control plane to republish routing now, instead of at the next
// reconcile. The runner cannot reach Caddy's admin socket itself.
function reloadRouting() {
  return new Promise((resolve) => {
    const url = new URL('/_internal/routing/reload', config.internalAuthUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', timeout: 15000,
      headers: { Authorization: `Bearer ${config.runnerToken}` }
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * The new container is up and answering. Record it, move routing over, and stop
 * the PM2 process this app may have been running under before.
 */
async function promote(app, appendLog) {
  await db.update(schema.apps).set({ nodeIsolation: 'container', updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  const routed = await reloadRouting();
  await appendLog(routed ? 'Routing moved to the container' : 'Routing will move to the container at the next reconcile');
  // Only once routing has moved: until then the old process is what people reach.
  if (routed) {
    try {
      execFileSync('pm2', ['delete', app.slug], { stdio: 'ignore', timeout: 15000 });
      execFileSync('pm2', ['save'], { stdio: 'ignore', timeout: 15000 });
      await appendLog('Stopped the previous PM2 process');
    } catch { /* there was none */ }
  }
}

/** The reverse: the platform went back to PM2, and this app now runs there. */
async function demote(app, appendLog) {
  await db.update(schema.apps).set({ nodeIsolation: 'pm2', updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  const routed = await reloadRouting();
  await appendLog(routed ? 'Routing moved back to PM2' : 'Routing will move back to PM2 at the next reconcile');
  if (routed) {
    try { docker(['rm', '-f', `app-${app.slug}`]); await appendLog('Removed the previous container'); }
    catch { /* already gone */ }
  }
}

module.exports = { deployNodeContainer, promote, demote, layout, buildScripts, reloadRouting, APP_UID };
