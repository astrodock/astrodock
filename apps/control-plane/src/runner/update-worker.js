'use strict';

// Runs inside the one-shot updater container. Everything here happens while the
// rest of the platform is being torn down and rebuilt around it, so it holds no
// assumptions about the api or the runner being alive at any given moment.
//
//   1. back up the database — the only way back from a bad migration
//   2. pin the requested version in .env, so the state on disk matches reality
//   3. pull, then recreate the stack
//   4. wait for the api to answer, and to answer as the version we asked for
//   5. if it does not: put .env back, recreate again, and say so
//
// The outcome goes into the events table rather than a log nobody will read, so
// the dashboard can show it once it comes back.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT = '/project';
const ENV_FILE = process.env.ASTRODOCK_UPDATE_ENV_FILE || path.join(PROJECT, '.env');
const TO = (process.env.ASTRODOCK_UPDATE_TO || '').trim();
const FROM = (process.env.ASTRODOCK_UPDATE_FROM || '').trim();
const ACTOR = process.env.ASTRODOCK_UPDATE_ACTOR || 'system';
const PROJECT_NAME = process.env.ASTRODOCK_UPDATE_PROJECT || 'astrodock';

const HEALTH_TRIES = 60;      // 60 × 3s = three minutes for the stack to come back
const HEALTH_EVERY_MS = 3000;

function run(cmd, args, { timeout = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().slice(0, 2000)));
        resolve(String(stdout || ''));
      });
  });
}
// Compose looks for its file in the working directory, and this process starts in
// the app directory inside the image — which has no docker-compose.yml. Point it
// at the mounted project explicitly rather than relying on cwd.
const compose = (...args) => run('docker', [
  'compose', '-p', PROJECT_NAME, '--project-directory', PROJECT, '-f', path.join(PROJECT, 'docker-compose.yml'), ...args
]);

// Rewrite ASTRODOCK_VERSION in .env, adding it if it was never there — an install
// that has always tracked `latest` has no such line. Returns what it replaced, so
// a rollback can put the file back exactly as it was.
function pinVersion(value) {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* a missing .env is odd but not fatal */ }
  const had = /^ASTRODOCK_VERSION=(.*)$/m.exec(text);
  const previous = had ? had[1] : null;
  if (value == null) {
    // restore: drop the line entirely if we were the ones who added it
    text = previous === null ? text : text.replace(/^ASTRODOCK_VERSION=.*$/m, '');
  } else if (had) {
    text = text.replace(/^ASTRODOCK_VERSION=.*$/m, `ASTRODOCK_VERSION=${value}`);
  } else {
    text = text.replace(/\n*$/, '\n') + `ASTRODOCK_VERSION=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, text);
  return previous;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The api answers on its compose service name; we joined its network to ask.
async function waitForApi(expect) {
  let last = null;
  for (let i = 0; i < HEALTH_TRIES; i++) {
    try {
      const res = await fetch('http://api:3100/health', { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const body = await res.json();
        last = body.version || null;
        // With no specific target we only need it alive; with one, it has to be
        // the version we asked for — otherwise the pull silently did nothing.
        if (!expect || String(last).replace(/^v/, '') === String(expect).replace(/^v/, '')) {
          return { ok: true, version: last };
        }
      }
    } catch { /* still coming up */ }
    await sleep(HEALTH_EVERY_MS);
  }
  return { ok: false, version: last };
}

async function record(type, severity, message, meta) {
  try {
    const { emitEvent } = require('../lib/events');
    await emitEvent({
      category: 'system', type, severity, actor: ACTOR, actorType: 'admin',
      targetType: 'platform', targetId: 'astrodock', message, meta
    });
  } catch (err) {
    console.error('[update] could not record the outcome:', err.message);
  }
}

async function main() {
  console.log(`[update] ${FROM || 'unknown'} → ${TO || 'latest'}`);
  await record('update.started', 'warning', `Update started: ${FROM || 'unknown'} → ${TO || 'latest'}`, { from: FROM, to: TO });

  // 1. A backup first, always. A release that migrates the schema is exactly the
  //    kind that cannot be undone by putting the old image back.
  let backupFile = null;
  try {
    const { runBackup } = require('../lib/backups');
    const b = await runBackup({ trigger: 'pre-update' });
    if (!b.ok) throw new Error(b.error);
    backupFile = path.basename(b.file);
    console.log(`[update] backup taken: ${backupFile}`);
  } catch (err) {
    await record('update.failed', 'critical',
      `Update aborted: the safety backup failed (${err.message}). Nothing was changed.`, { from: FROM, to: TO });
    process.exit(1);
  }

  // 2/3. Pin, pull, recreate.
  const previousPin = TO ? pinVersion(TO) : null;
  try {
    console.log('[update] pulling…');
    await compose('pull');
    console.log('[update] recreating…');
    await compose('up', '-d');
  } catch (err) {
    if (TO) pinVersion(previousPin);
    await record('update.failed', 'critical',
      `Update failed while starting the new version: ${err.message}`, { from: FROM, to: TO, backup: backupFile });
    process.exit(1);
  }

  // 4. Did it actually come back, as the thing we asked for?
  const health = await waitForApi(TO);
  if (health.ok) {
    console.log(`[update] up on ${health.version}`);
    await record('update.succeeded', 'info',
      `Updated to ${health.version || TO || 'the latest release'}`,
      { from: FROM, to: health.version, backup: backupFile });
    return;
  }

  // 5. It did not. Put it back.
  console.error('[update] the new version did not come up; rolling back');
  try {
    pinVersion(previousPin === null && TO ? null : (previousPin || FROM || null));
    await compose('pull');
    await compose('up', '-d');
    const back = await waitForApi(null);
    await record('update.rolled_back', 'critical',
      back.ok
        ? `Update to ${TO || 'the latest release'} did not come up. Rolled back to ${back.version || FROM || 'the previous version'}.`
        : `Update to ${TO || 'the latest release'} did not come up, and neither did the rollback. Restore ${backupFile} and start the stack by hand.`,
      { from: FROM, to: TO, backup: backupFile, rollbackHealthy: back.ok });
    process.exit(back.ok ? 1 : 2);
  } catch (err) {
    await record('update.rolled_back', 'critical',
      `Update failed and the rollback also failed: ${err.message}. The database backup ${backupFile} is on the server.`,
      { from: FROM, to: TO, backup: backupFile });
    process.exit(2);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[update] unexpected failure:', err);
      await record('update.failed', 'critical', `Update failed unexpectedly: ${err.message}`, { from: FROM, to: TO });
      process.exit(1);
    });
}

// pinVersion is the part that edits a file on the operator's disk, so it is
// exported to be tested directly rather than only through a container.
module.exports = { pinVersion, ENV_FILE };
