'use strict';

// Runs in the runner container before `pm2 resurrect` (docker-entrypoint.sh).
//
// An update recreates this container, and with it /etc/passwd, so the per-app
// users the deploys created are gone until each app deploys again. PM2 brings
// the apps back from its dump, which holds each app's user as numbers, not a
// name. This puts the users back first, on the same safe ids a deploy would
// give them (runner/app-user.js), moves files still owned by an old id, and
// writes the new ids into the dump. Without that last step an app moved to a
// new id is resurrected as its old one, can't read its own folder, and
// restarts forever.
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

// Point every dump entry for an app at the app's current ids. Both the dump and
// its .bak, since `pm2 resurrect` falls back to the .bak.
function setDumpIds(idsBySlug) {
  for (const file of ['dump.pm2', 'dump.pm2.bak']) {
    const full = path.join(PM2_HOME, file);
    try {
      const dump = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!Array.isArray(dump)) continue;
      let changed = 0;
      for (const p of dump) {
        const ids = p && idsBySlug[p.name];
        if (!ids || (p.uid === ids.uid && p.gid === ids.gid)) continue;
        p.uid = ids.uid;
        p.gid = ids.gid;
        changed += 1;
      }
      if (changed) {
        fs.writeFileSync(`${full}.tmp`, JSON.stringify(dump), { mode: 0o600 });
        fs.renameSync(`${full}.tmp`, full);
        log(`${file}: set the user of ${changed} app(s)`);
      }
    } catch { /* missing or unreadable: pm2 resurrect has nothing to bring back from it */ }
  }
}

function restoreUsers() {
  const idsBySlug = {};
  for (const slug of pm2Apps()) {
    try {
      const u = appUsers.ensureAppUser(slug);
      idsBySlug[slug] = { uid: u.uid, gid: u.gid };
      for (const dir of [path.join(APPS, slug), path.join(APPS, `${slug}.home`), path.join(REPOS, slug)]) chownIfNeeded(dir, u);
      // The old in-tree PM2 config held the app's secrets; PM2 runs from its dump.
      for (const old of ['ecosystem.config.js', 'ecosystem.config.cjs']) fs.rmSync(path.join(APPS, slug, old), { force: true });
    } catch (err) { log(`${slug}: ${err.message}`); }
  }
  setDumpIds(idsBySlug);
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

module.exports = { pm2Apps, restoreUsers, takeBackStatic, setDumpIds };
