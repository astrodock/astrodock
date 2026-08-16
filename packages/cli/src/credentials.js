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

function loadCredentials(cwd = process.cwd()) {
  const out = {};
  const file = path.join(cwd, CRED_FILE);
  if (fs.existsSync(file)) {
    assertNotTracked(cwd);
    Object.assign(out, parseCredFile(fs.readFileSync(file, 'utf8')));
  }
  if (process.env.ASTRODOCK_URL) out.ASTRODOCK_URL = process.env.ASTRODOCK_URL;
  if (process.env.ASTRODOCK_TOKEN) out.ASTRODOCK_TOKEN = process.env.ASTRODOCK_TOKEN;
  return out;
}

module.exports = { loadCredentials, parseCredFile, CRED_FILE };
