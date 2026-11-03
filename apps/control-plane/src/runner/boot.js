'use strict';

// Runs in the runner container before `pm2 resurrect` (docker-entrypoint.sh).
//
// An update recreates this container, and with it /etc/passwd, so the per-app
// users the deploys created are gone until each app deploys again. PM2 brings
// the apps back from its dump by user name. This puts the users back first, on
// the same safe ids a deploy would give them (runner/app-user.js), and moves
// files still owned by an old id.
//
// It also takes back the published static folders. They used to be left owned
// by the app's user, so a running app could add a link to one after the deploy
// and Caddy, which serves them from its own container, would follow it.
//
// Nothing here may stop the runner from starting: every step is best effort.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const appUsers = require('./app-user');

const APPS = process.env.ASTRODOCK_APPS_DIR || '/data/apps';
const REPOS = process.env.ASTRODOCK_REPOS_DIR || '/data/repos';
const STATIC = process.env.ASTRODOCK_STATIC_DIR || '/data/static';
const PM2_HOME = process.env.PM2_HOME || '/data/pm2';

const log = (msg) => console.log(`[runner boot] ${msg}`);

// PM2 apps saved in the dump: the ones that will be resurrected.
function pm2Apps() {
  try {
    const dump = JSON.parse(fs.readFileSync(path.join(PM2_HOME, 'dump.pm2'), 'utf8'));
    return [...new Set((Array.isArray(dump) ? dump : []).map((p) => p && p.name).filter((n) => /^[a-z0-9-]+$/.test(String(n))))];
  } catch { return []; }
}

function chownIfNeeded(dir, ids) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return;
    if (st.uid === ids.uid && st.gid === ids.gid) return;
    // -h: a link is changed itself, never what it points at.
    execFileSync('chown', ['-R', '-h', `${ids.uid}:${ids.gid}`, dir]);
    log(`gave ${dir} to ${ids.uid}`);
  } catch { /* missing, or not ours to change */ }
}

function restoreUsers() {
  for (const slug of pm2Apps()) {
    try {
      const u = appUsers.ensureAppUser(slug);
      for (const dir of [path.join(APPS, slug), path.join(APPS, `${slug}.home`), path.join(REPOS, slug)]) chownIfNeeded(dir, u);
      // The old in-tree PM2 config held the app's secrets; PM2 runs from its dump.
      for (const old of ['ecosystem.config.js', 'ecosystem.config.cjs']) fs.rmSync(path.join(APPS, slug, old), { force: true });
    } catch (err) { log(`${slug}: ${err.message}`); }
  }
}

function takeBackStatic() {
  if (!fs.existsSync(STATIC)) return;
  try {
    execFileSync('chown', ['-R', '-h', 'root:root', STATIC]);
    execFileSync('chmod', ['-R', 'u=rwX,go=rX', STATIC]);
    execFileSync('find', [STATIC, '-type', 'l', '-delete']);
  } catch (err) { log(`static: ${err.message}`); }
}

if (require.main === module) {
  if (process.getuid && process.getuid() !== 0) process.exit(0);
  takeBackStatic();
  restoreUsers();
}

module.exports = { pm2Apps, restoreUsers, takeBackStatic };
