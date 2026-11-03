'use strict';

// The Unix user a Node app runs as when PM2 runs it inside the runner container.
//
// `useradd -r` used to pick these: system ids, counting down from 999. That is
// where many Debian and Ubuntu hosts put their `docker` group, and the Docker
// socket is bind-mounted with the host's numbers, so an app whose group number
// happened to match could drive Docker, which is root on the host.
//
// Ids now come from a fixed high range, derived from the slug so the same app
// gets the same id after the runner container is recreated, and never the
// socket's group. An app still on an old id is moved the next time it deploys.

const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ID_MIN = 20000;
const ID_SPAN = 40000;
const SOCKET = '/var/run/docker.sock';

const nameFor = (slug) => `tsapp_${String(slug).replace(/[^a-z0-9]/g, '_')}`;

function socketGid() {
  try { return fs.statSync(SOCKET).gid; } catch { return null; }
}

/** { uid, gid } of a user, or null if there is no such user. */
function lookup(name) {
  try {
    return {
      uid: parseInt(execFileSync('id', ['-u', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), 10),
      gid: parseInt(execFileSync('id', ['-g', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), 10)
    };
  } catch { return null; }
}

// Who holds an id (or a name) in passwd or group, or null.
function holder(db, key) {
  try { return execFileSync('getent', [db, String(key)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(':')[0] || null; } catch { return null; }
}

/** True for ids an app may run with: in the range, not root, not the socket's group. */
function safeIds(ids) {
  if (!ids) return false;
  const sock = socketGid();
  return ids.uid >= ID_MIN && ids.gid >= ID_MIN && ids.uid < ID_MIN + ID_SPAN && ids.gid < ID_MIN + ID_SPAN
    && ids.gid !== sock && ids.uid !== 0 && ids.gid !== 0;
}

function preferredId(slug) {
  const h = crypto.createHash('sha256').update(String(slug)).digest().readUInt32BE(0);
  return ID_MIN + (h % ID_SPAN);
}

// The slug's id, or the next one up that nobody else holds as a user or a group.
function freeId(slug, name) {
  const sock = socketGid();
  let id = preferredId(slug);
  for (let i = 0; i < ID_SPAN; i += 1) {
    const u = holder('passwd', id);
    const g = holder('group', id);
    if (id !== sock && (!u || u === name) && (!g || g === name)) return id;
    id = ID_MIN + ((id - ID_MIN + 1) % ID_SPAN);
  }
  throw new Error('No free user id left for this app.');
}

// Every process running as `uid`, ended. An id can only change once nothing runs
// under it, and an app's leftover processes (its old instance, or anything its
// install scripts left behind) are exactly what must not outlive the move.
function killProcessesOf(uid) {
  let killed = 0;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m && Number(m[1]) === uid) { process.kill(Number(pid), 'SIGKILL'); killed += 1; }
    } catch { /* gone already */ }
  }
  return killed;
}

/**
 * Make sure the app's user exists with safe ids, creating or moving it.
 * `beforeMove` runs first when an existing user has to change ids (stop the app).
 * Returns { name, uid, gid, moved }.
 */
function ensureAppUser(slug, { beforeMove } = {}) {
  const name = nameFor(slug);
  const current = lookup(name);
  if (current && safeIds(current) && current.uid === current.gid) return { name, ...current, moved: false };

  const id = freeId(slug, name);
  if (current) {
    if (beforeMove) beforeMove(current);
    killProcessesOf(current.uid);
  }
  if (holder('group', name)) execFileSync('groupmod', ['-g', String(id), name]);
  else execFileSync('groupadd', ['-g', String(id), name]);
  if (current) execFileSync('usermod', ['-u', String(id), '-g', String(id), name]);
  else execFileSync('useradd', ['-u', String(id), '-g', String(id), '-M', '-s', '/usr/sbin/nologin', name]);

  const ids = lookup(name);
  if (!safeIds(ids)) throw new Error(`The user for "${slug}" could not be given a safe id.`);
  return { name, ...ids, moved: !!current };
}

/** The app's user if it exists with safe ids, else null. Never creates one. */
function existingAppUser(slug) {
  const ids = lookup(nameFor(slug));
  return safeIds(ids) ? ids : null;
}

// Where the runner keeps an app's generated config (its PM2 config, its
// Dockerfile env file): beside PM2's own state, root-only, outside every app's
// tree, so neither the app nor the file browser can reach it.
function appConfigDir() {
  const dir = process.env.ASTRODOCK_APP_CONFIG_DIR || `${process.env.PM2_HOME || '/data/pm2'}/app-config`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change in dev */ }
  return dir;
}

function appConfigFile(slug, kind) {
  if (!/^[a-z0-9-]+$/.test(String(slug))) throw new Error('Bad app slug.');
  return `${appConfigDir()}/${slug}.${kind}`;
}

module.exports = {
  ensureAppUser, existingAppUser, nameFor, safeIds, preferredId, appConfigFile, ID_MIN, ID_SPAN
};
