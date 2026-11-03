'use strict';

// Structured operations on a deployed app — what the terminal was actually used
// for, offered as named actions instead of a shell.
//
// The route this replaces spawned `sh -c` in the API CONTAINER, which loads the
// whole .env: the key that decrypts every app's secrets, the admin JWT signing
// secret, the runner token, the database password. It was also broken — the app's
// files live on the runner, which the API does not mount — so it could not do the
// job it existed for while being able to compromise everything.
//
// The distinction that does the real work here:
//
//   COMMITTED commands (declared in app.json) are code a human reviewed and
//   committed. COMPOSED commands (a string assembled from log output) are not —
//   and an agent debugging an app is reading build logs, runtime logs, HTTP access
//   logs and repository contents, all of which an attacker can influence.
//
// So an agent may run the app's own `migrate` script. It may not run `sh -c
// "$(whatever the logs suggested)"`. Same mechanism, entirely different trust.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { decryptSecret } = require('../lib/crypto');

const MAX_FILE_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const within = (root, p) => p === root || p.startsWith(root + path.sep);

/** Resolve a path INSIDE the app's directory, or refuse. */
function resolveInApp(slug, relative) {
  const root = path.resolve(config.paths.apps, slug);
  const target = path.resolve(root, relative || '.');
  // Containment check on the resolved path, so ../ inputs cannot walk out into
  // the runner's own filesystem.
  if (!within(root, target)) throw new Error('That path is outside the app.');
  // Then again on the REAL path. The app's own process owns this directory and can
  // plant a symlink in it; this code reads as root, so following a link to another
  // app's ecosystem file would hand over that app's secrets.
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(target);
  } catch (err) {
    // Missing (or a dangling link): callers report "no such file" themselves.
    if (err.code === 'ENOENT') return { root, target };
    throw err;
  }
  if (!within(realRoot, real)) throw new Error('That path is outside the app.');
  return { root: realRoot, target: real };
}

// ── Node apps in a container of their own ────────────────────────────────────
// Their files are inside the container, not on the runner's disk. Reading them
// runs this script there, as the app's own uid, with the same two containment
// checks as resolveInApp: the resolved path, then the real one.
const IN_CONTAINER_SCRIPT = `
const fs = require('fs'), path = require('path');
const [op, rel, max] = process.argv.slice(1);
const within = (r, p) => p === r || p.startsWith(r + path.sep);
const root = fs.realpathSync(process.cwd());
const target = path.resolve(root, rel || '.');
const out = (o) => process.stdout.write(JSON.stringify(o));
if (!within(root, target)) { out({ error: 'That path is outside the app.' }); process.exit(0); }
let real; try { real = fs.realpathSync(target); } catch { out({ error: op === 'list' ? 'No such directory in this app.' : 'No such file in this app.' }); process.exit(0); }
if (!within(root, real)) { out({ error: 'That path is outside the app.' }); process.exit(0); }
const st = fs.statSync(real);
if (op === 'list') {
  if (!st.isDirectory()) { out({ error: 'That is a file, not a directory.' }); process.exit(0); }
  out({ entries: fs.readdirSync(real, { withFileTypes: true }).map((e) => {
    let size = null; try { size = e.isFile() ? fs.statSync(path.join(real, e.name)).size : null; } catch {}
    return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
  }) });
} else {
  if (!st.isFile()) { out({ error: 'No such file in this app.' }); process.exit(0); }
  if (st.size > Number(max)) { out({ error: 'too_big', size: st.size }); process.exit(0); }
  out({ size: st.size, data: fs.readFileSync(real).toString('base64') });
}
`;

// PM2 apps: the same script, run on the runner as the app's own user, so a link
// the app swaps in between a check and a read can only reach what the app could
// read anyway. Reading as root left a gap between checking a path and opening it.
function asAppUserOp(app, ids, op, relative) {
  const { execFileSync } = require('child_process');
  const root = path.resolve(config.paths.apps, app.slug);
  if (!fs.existsSync(root)) throw new Error('This app has not been deployed yet.');
  let raw;
  try {
    raw = execFileSync(process.execPath, ['-e', IN_CONTAINER_SCRIPT, op, relative || '.', String(MAX_FILE_BYTES)], {
      cwd: root, env: { PATH: process.env.PATH }, uid: ids.uid, gid: ids.gid,
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch { throw new Error('The app\'s files could not be read.'); }
  const res = JSON.parse(raw || '{}');
  if (res.error === 'too_big') throw new Error(`That file is ${Math.round(res.size / 1024)}KB; the limit is ${MAX_FILE_BYTES / 1024}KB.`);
  if (res.error) throw new Error(res.error);
  return res;
}

// Which way this app's files and commands are reached. Never as root: the runner
// holds the Docker socket, so root here is root on the host.
//   container  a Node app in its own container (docker exec, uid 1000)
//   docker     a Dockerfile app (docker exec into its container, as the image's user)
//   user       a PM2 app with its own user, on safe ids
function accessFor(app) {
  if (nodeInContainer(app)) return { kind: 'container' };
  if (app && typeof app === 'object' && app.runtimeType === 'docker') return { kind: 'docker' };
  const ids = appIds(app);
  if (ids) return { kind: 'user', ids };
  throw new Error('This app has no user of its own yet. Redeploy it, then try again.');
}

function nodeInContainer(app) {
  return app && typeof app === 'object' && app.runtimeType !== 'docker' && app.nodeIsolation === 'container';
}

function execInApp(app, args, { timeout = 15000 } = {}) {
  const { execFileSync } = require('child_process');
  return execFileSync('docker', ['exec', '-u', '1000', `app-${app.slug}`, ...args],
    { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function inContainerOp(app, op, relative) {
  let raw;
  try { raw = execInApp(app, ['node', '-e', IN_CONTAINER_SCRIPT, op, relative || '.', String(MAX_FILE_BYTES)]); }
  catch { throw new Error('The app is not running, so its files cannot be read.'); }
  const res = JSON.parse(raw || '{}');
  if (res.error === 'too_big') throw new Error(`That file is ${Math.round(res.size / 1024)}KB; the limit is ${MAX_FILE_BYTES / 1024}KB.`);
  if (res.error) throw new Error(res.error);
  return res;
}

const slugOf = (appOrSlug) => (typeof appOrSlug === 'string' ? appOrSlug : appOrSlug.slug);

function listDirectory(appOrSlug, relative = '.') {
  const access = typeof appOrSlug === 'object' ? accessFor(appOrSlug) : { kind: 'root' };
  if (access.kind === 'container' || access.kind === 'user') {
    const res = access.kind === 'user' ? asAppUserOp(appOrSlug, access.ids, 'list', relative) : inContainerOp(appOrSlug, 'list', relative);
    return res.entries
      .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.git'))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }
  const slug = slugOf(appOrSlug);
  const { target } = resolveInApp(slug, relative);
  if (!fs.existsSync(target)) throw new Error('No such directory in this app.');
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error('That is a file, not a directory.');
  return fs.readdirSync(target, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.git'))
    .map((e) => {
      const full = path.join(target, e.name);
      let size = null;
      try { size = e.isFile() ? fs.statSync(full).size : null; } catch { /* raced */ }
      return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

// Every secret this app holds, longest first so a value that contains another
// is masked before its substring is.
function secretValues(envVars) {
  return (envVars || [])
    .filter((v) => v.isSecret && v.value)
    .map((v) => {
      // Stored secrets are encrypted at rest; compare against the plaintext.
      try { return decryptSecret(v.value); } catch { return v.value; }
    })
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

// The env tab masks secrets to ••••••. This reader served the same values in
// the clear, because ecosystem.config.js *is* the environment written to disk
// — so a token with only `logs:read` could read every key the app holds. Mask
// on the way out, whatever file they came from: a .env, a config, a log line
// that printed one.
// The secrets the platform injects (database URL and password, app secret, JWT
// secret, storage key). Masking used to cover only the app's declared secrets,
// so these came back in the clear from files like a generated env file, and
// from build output that printed them.
const PLATFORM_SECRET_KEY = /SECRET|PASSWORD|TOKEN|DATABASE_URL|_KEY$/;
function platformSecretValues(app, envVars) {
  if (!app || typeof app !== 'object') return [];
  let env;
  try { env = require('../lib/env-compute').computeEnv(app, envVars || []); } catch { return []; }
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('ASTRODOCK_') || !PLATFORM_SECRET_KEY.test(k) || !v || String(v).length < 8) continue;
    out.push(String(v));
    // A connection string's password also appears on its own.
    try { const pw = decodeURIComponent(new URL(String(v)).password || ''); if (pw.length >= 8) out.push(pw); } catch { /* not a URL */ }
  }
  return out;
}

function maskSecrets(text, envVars, extra = []) {
  let out = String(text);
  let hits = 0;
  const all = [...new Set([...secretValues(envVars), ...extra])].sort((a, b) => b.length - a.length);
  for (const secret of all) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join('••••••');
    hits += 1;
  }
  return { text: out, masked: hits };
}

function readFile(appOrSlug, relative, envVars) {
  if (!relative) throw new Error('Which file?');
  const access = typeof appOrSlug === 'object' ? accessFor(appOrSlug) : { kind: 'root' };
  if (access.kind === 'container' || access.kind === 'user') {
    const res = access.kind === 'user' ? asAppUserOp(appOrSlug, access.ids, 'read', relative) : inContainerOp(appOrSlug, 'read', relative);
    const data = Buffer.from(res.data, 'base64');
    if (data.includes(0)) throw new Error('That looks like a binary file.');
    const { text, masked } = maskSecrets(data.toString('utf8'), envVars, platformSecretValues(appOrSlug, envVars));
    return { path: relative, size: res.size, content: text, secretsMasked: masked };
  }
  const slug = slugOf(appOrSlug);
  const { target } = resolveInApp(slug, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('No such file in this app.');
  // O_NOFOLLOW: a link swapped in after the check above is refused, not followed.
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let buf;
  let size;
  try {
    size = fs.fstatSync(fd).size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(`That file is ${Math.round(size / 1024)}KB; the limit is ${MAX_FILE_BYTES / 1024}KB.`);
    }
    buf = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Binary would be noise at best and a terminal-escape vector at worst.
  if (buf.includes(0)) throw new Error('That looks like a binary file.');
  const { text, masked } = maskSecrets(buf.toString('utf8'), envVars, platformSecretValues(appOrSlug, envVars));
  return { path: relative, size, content: text, secretsMasked: masked };
}

/**
 * The app's runtime environment, with secret VALUES withheld.
 *
 * Answers "is DATABASE_URL actually set in the running process" without
 * disclosing it — which is the real question when an app will not start.
 */
function runtimeEnv(app, envVars) {
  const { computeEnv } = require('../lib/env-compute');
  const computed = computeEnv(app, envVars);
  const secretKeys = new Set(envVars.filter((v) => v.isSecret).map((v) => v.key));
  return Object.keys(computed).sort().map((key) => {
    const secret = secretKeys.has(key) || /SECRET|PASSWORD|KEY|TOKEN|_URL$/.test(key);
    const value = computed[key];
    return {
      key,
      isSet: value != null && value !== '',
      length: value ? String(value).length : 0,
      value: secret ? null : value
    };
  });
}

// The app's per-app user (created by the deploy), or null if it has none or is
// still on old ids that could share the Docker socket's group (runner/app-user).
function appIds(app) {
  return require('./app-user').existingAppUser(app.slug);
}

/**
 * Run a command DECLARED IN app.json — never one supplied by the caller.
 * `name` selects from the manifest's `scripts` map; anything not listed is refused.
 */
function declaredCommands(app) {
  const scripts = (app.manifest && app.manifest.scripts) || {};
  return Object.keys(scripts);
}

function runDeclared(app, envVars, name) {
  const scripts = (app.manifest && app.manifest.scripts) || {};
  const command = scripts[name];
  if (!command) {
    const available = Object.keys(scripts);
    throw new Error(available.length
      ? `No such command. This app declares: ${available.join(', ')}`
      : 'This app declares no commands. Add a "scripts" map to its app.json.');
  }

  const { computeEnv } = require('../lib/env-compute');
  const access = accessFor(app);
  const cwd = path.resolve(config.paths.apps, app.slug);
  if (access.kind === 'user' && !fs.existsSync(cwd)) throw new Error('This app has not been deployed yet.');

  // In a container of its own, the command runs there, with the environment the
  // container already has. On the runner, as the app's own user, never as root.
  const [file, args, opts] = access.kind === 'container'
    ? ['docker', ['exec', '-u', '1000', `app-${app.slug}`, 'sh', '-c', command], {}]
    : access.kind === 'docker'
      ? ['docker', ['exec', `app-${app.slug}`, 'sh', '-c', command], {}]
      : ['sh', ['-c', command], {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, ...computeEnv(app, envVars) },
        ...access.ids
      }];

  return new Promise((resolve) => {
    // Still `sh -c`, but the string comes from the repository rather than the
    // request — the caller chooses WHICH declared command, never its text.
    execFile(file, args, {
      ...opts,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({
        name,
        command,
        exitCode: err ? (err.code == null ? 1 : err.code) : 0,
        timedOut: !!(err && err.killed),
        stdout: String(stdout || '').slice(-200000),
        stderr: String(stderr || '').slice(-200000)
      });
    });
  });
}

// ── The terminal ─────────────────────────────────────────────────────────────
//
// Off unless ASTRODOCK_ENABLE_TERMINAL is true. This is arbitrary code
// execution by design; see SECURITY.md.
//
// Ported from the precursor's /exec SSE route, whose shape was right and whose
// address was not. That one ran in the API container, which loads the key that
// decrypts every app's secrets, and it could not read the app files it was
// aimed at because those live here on the runner. Running it here fixes both:
// the files are local, and the environment handed to the command is the app's
// own, computed exactly as PM2's is.
//
// The command text comes from the caller, which is the whole point and the
// whole risk. It is gated on the `exec` scope, which no preset grants and the
// operator role does not carry, and every invocation is audited upstream.

function terminalEnabled() {
  return String(process.env.ASTRODOCK_ENABLE_TERMINAL || '').toLowerCase() === 'true';
}

const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

// Streams to an SSE response. Resolves when the child is done.
function runInteractive(app, envVars, command, res) {
  const { spawn } = require('child_process');
  const { computeEnv } = require('../lib/env-compute');
  const access = accessFor(app);
  const cwd = path.resolve(config.paths.apps, app.slug);
  if (access.kind === 'user' && !fs.existsSync(cwd)) throw new Error('This app has not been deployed yet.');

  const secrets = [...new Set([...secretValues(envVars), ...platformSecretValues(app, envVars)])].sort((a, b) => b.length - a.length);
  const mask = (chunk) => {
    let out = String(chunk);
    for (const v of secrets) if (out.includes(v)) out = out.split(v).join('••••••');
    return out;
  };

  // The app's own user, or its own container, so a shell here is no more
  // powerful than the app. A Dockerfile app used to land here with no user of
  // its own and ran as root on the runner.
  const child = access.kind === 'container'
    ? spawn('docker', ['exec', '-u', '1000', `app-${app.slug}`, 'sh', '-c', command], { timeout: EXEC_TIMEOUT_MS })
    : access.kind === 'docker'
      ? spawn('docker', ['exec', `app-${app.slug}`, 'sh', '-c', command], { timeout: EXEC_TIMEOUT_MS })
      : spawn('sh', ['-c', command], {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, ...computeEnv(app, envVars) },
        timeout: EXEC_TIMEOUT_MS,
        ...access.ids
      });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  child.stdout.on('data', (c) => send('stdout', mask(c)));
  child.stderr.on('data', (c) => send('stderr', mask(c)));
  child.on('close', (code, signal) => {
    send('exit', { code, signal: signal || null, timedOut: signal === 'SIGTERM' && code === null });
    res.end();
  });
  child.on('error', (err) => { send('error', mask(err.message)); res.end(); });

  // Closing the tab stops the command rather than leaving it running.
  res.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
  return child;
}

module.exports = {
  listDirectory, readFile, runtimeEnv, declaredCommands, runDeclared, resolveInApp,
  maskSecrets, platformSecretValues, terminalEnabled, runInteractive, accessFor, MAX_FILE_BYTES
};
