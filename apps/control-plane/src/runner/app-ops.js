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

const MAX_FILE_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolve a path INSIDE the app's directory, or refuse. */
function resolveInApp(slug, relative) {
  const root = path.resolve(config.paths.apps, slug);
  const target = path.resolve(root, relative || '.');
  // Containment check on the resolved path, so ../ and symlink-ish inputs cannot
  // walk out into the runner's own filesystem.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('That path is outside the app.');
  }
  return { root, target };
}

function listDirectory(slug, relative = '.') {
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

function readFile(slug, relative) {
  if (!relative) throw new Error('Which file?');
  const { target } = resolveInApp(slug, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('No such file in this app.');
  const size = fs.statSync(target).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(`That file is ${Math.round(size / 1024)}KB; the limit is ${MAX_FILE_BYTES / 1024}KB.`);
  }
  const buf = fs.readFileSync(target);
  // Binary would be noise at best and a terminal-escape vector at worst.
  if (buf.includes(0)) throw new Error('That looks like a binary file.');
  return { path: relative, size, content: buf.toString('utf8') };
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
  const cwd = path.resolve(config.paths.apps, app.slug);
  if (!fs.existsSync(cwd)) throw new Error('This app has not been deployed yet.');

  return new Promise((resolve) => {
    // Still `sh -c`, but the string comes from the repository rather than the
    // request — the caller chooses WHICH declared command, never its text.
    execFile('sh', ['-c', command], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...computeEnv(app, envVars) },
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

module.exports = { listDirectory, readFile, runtimeEnv, declaredCommands, runDeclared, resolveInApp, MAX_FILE_BYTES };
