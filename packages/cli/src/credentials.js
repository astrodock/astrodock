'use strict';

// Resolve ASTRODOCK_URL / ASTRODOCK_TOKEN for the CLI.
//
// Environment variables win, so CI and one-off overrides keep working. Otherwise
// the credentials come from `.env.astrodock` in the current directory: one
// narrowly-scoped token per app repo, sitting next to the app.json it operates
// on, instead of one master token ambient in somebody's shell profile.
//
// The file is read from cwd only, never parent directories. Walking up would let
// a broader token in a parent folder silently apply to a nested repo — the
// master-token failure mode reintroduced through the filesystem.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CRED_FILE = '.env.astrodock';
const ALLOWED = new Set(['ASTRODOCK_URL', 'ASTRODOCK_TOKEN']);

// KEY=VALUE lines; #-comments and blank lines skipped; optional single or double
// quotes around the value. Keys outside ALLOWED are ignored rather than fatal —
// the file belongs to the operator, and tolerating a stray line beats refusing
// to deploy over one.
function parseCredFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!ALLOWED.has(key)) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) out[key] = val;
  }
  return out;
}

// A token committed to git is a leak with a timestamp. Only a confirmed
// "tracked" verdict is fatal: git being absent, cwd not being a repo, or the
// file being untracked all exit non-zero and mean there is nothing to block on.
function assertNotTracked(cwd) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', CRED_FILE], { cwd, stdio: 'ignore' });
  } catch {
    return;
  }
  throw new Error(
    `${CRED_FILE} is tracked by git — a committed token is a leaked token. ` +
    `Add "${CRED_FILE}" to .gitignore and run: git rm --cached ${CRED_FILE}`
  );
}

// The URL and the token must come from the same place. Mixing them let a
// .env.astrodock in a downloaded folder (one that is not a git repo, so the
// tracked-file guard never runs) supply the URL while the token came from the
// shell — sending a real token to whatever host that file named.
function loadCredentials(cwd = process.cwd()) {
  let fromFile = {};
  const file = path.join(cwd, CRED_FILE);
  if (fs.existsSync(file)) {
    assertNotTracked(cwd);
    fromFile = parseCredFile(fs.readFileSync(file, 'utf8'));
  }
  const fromEnv = {};
  if (process.env.ASTRODOCK_URL) fromEnv.ASTRODOCK_URL = process.env.ASTRODOCK_URL;
  if (process.env.ASTRODOCK_TOKEN) fromEnv.ASTRODOCK_TOKEN = process.env.ASTRODOCK_TOKEN;

  const envHasAny = !!(fromEnv.ASTRODOCK_URL || fromEnv.ASTRODOCK_TOKEN);
  if (!envHasAny) return fromFile;
  const mixed = (fromEnv.ASTRODOCK_TOKEN && !fromEnv.ASTRODOCK_URL && fromFile.ASTRODOCK_URL)
    || (fromEnv.ASTRODOCK_URL && !fromEnv.ASTRODOCK_TOKEN && fromFile.ASTRODOCK_TOKEN);
  if (mixed) {
    throw new Error(
      `ASTRODOCK_URL and ASTRODOCK_TOKEN come from different places (one from the environment, ` +
      `one from ${CRED_FILE}). Set both in the environment, or both in ${CRED_FILE}.`
    );
  }
  return fromEnv;
}

module.exports = { loadCredentials, parseCredFile, CRED_FILE };
