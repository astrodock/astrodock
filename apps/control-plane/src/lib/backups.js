'use strict';

// Postgres backups for the bundled stack. Runs on the RUNNER (it holds the Docker
// socket + the backups volume): pg_dumpall inside the bundled Postgres container,
// gzipped to the backups dir. Records each run + emits a system event (so a failed
// backup alerts through the notification spine). Best-effort, single-box durability;
// off-box copy to external object storage is a documented follow-up.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, schema } = require('../db');
const config = require('../config');
const { emitEvent } = require('./events');

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function runBackup({ trigger = 'scheduled' } = {}) {
  const dir = config.backups.dir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pg-${stamp()}.sql.gz`);
  try {
    // pipe to gzip; sanity-check the size after so a failed dump isn't logged as success
    execSync(`docker exec ${config.backups.pgContainer} pg_dumpall -U ${config.pg.user} | gzip > "${file}"`, {
      shell: '/bin/sh', timeout: 30 * 60 * 1000, stdio: ['ignore', 'ignore', 'pipe']
    });
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size < 100) throw new Error('dump produced an empty/too-small file (is the Postgres container reachable?)');
    await db.insert(schema.backups).values({ kind: 'postgres', status: 'success', sizeBytes: size, path: file, trigger });
    await emitEvent({ category: 'system', type: 'backup.succeeded', severity: 'info', message: `Backup complete (${(size / 1048576).toFixed(1)} MB)`, meta: { file, trigger } }).catch(() => {});
    await pruneOld(dir, config.backups.keep);
    return { ok: true, file, size };
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : '') || err.message;
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { await db.insert(schema.backups).values({ kind: 'postgres', status: 'failed', path: file, trigger, error: msg.slice(0, 1000) }); } catch { /* ignore */ }
    await emitEvent({ category: 'system', type: 'backup.failed', severity: 'critical', message: `Backup FAILED: ${msg.slice(0, 200)}`, meta: { trigger }, dedupeKey: 'system:backup.failed', dedupeWindowMs: 6 * 3600 * 1000 }).catch(() => {});
    return { ok: false, error: msg };
  }
}

// Keep the newest `keep` dumps on disk (ISO-stamped names sort chronologically).
async function pruneOld(dir, keep) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('pg-') && f.endsWith('.sql.gz')).sort(); }
  catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
}

function startBackupScheduler() {
  const hrs = config.backups.intervalHours;
  if (!hrs || hrs <= 0) { console.log('[backups] scheduler disabled (interval 0)'); return; }
  console.log(`[backups] scheduler every ${hrs}h → ${config.backups.dir}`);
  setTimeout(() => runBackup({ trigger: 'scheduled' }).catch(() => {}), 60_000);
  setInterval(() => runBackup({ trigger: 'scheduled' }).catch(() => {}), hrs * 3600 * 1000);
}

module.exports = { runBackup, pruneOld, startBackupScheduler };
