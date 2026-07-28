'use strict';

// Postgres backups for the bundled stack. Runs on the RUNNER (it holds the Docker
// socket + the backups volume): pg_dumpall inside the bundled Postgres container,
// gzipped to the backups dir. Records each run + emits a system event (so a failed
// backup alerts through the notification spine). Best-effort, single-box durability;
// off-box copy to external object storage is a documented follow-up.

const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { emitEvent } = require('./events');

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Every path that leaves this module is derived from a database row, but the
// row's `path` column is still just text — so resolve it and refuse anything
// that escapes the backups directory before opening or deleting it.
function safeResolve(p) {
  const dir = path.resolve(config.backups.dir);
  const resolved = path.resolve(p);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error('backup path is outside the backups directory');
  }
  return resolved;
}

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

// ── getting a dump off the box, and one back on ──────────────────────────────

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

async function findBackup(id) {
  const rows = await db.select().from(schema.backups).where(eq(schema.backups.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw Object.assign(new Error('No such backup.'), { status: 404 });
  if (row.status !== 'success') throw Object.assign(new Error('That backup did not complete, so there is nothing to read.'), { status: 400 });
  const file = safeResolve(row.path);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error('The file is gone from disk — it was pruned, or the volume was replaced.'), { status: 410 });
  }
  return { row, file };
}

// Accept a dump someone is bringing back to the box. Uploaded files are named
// with their own prefix so pruneOld (which only ever considers `pg-` files)
// cannot delete the copy someone deliberately carried in.
async function saveUploadedBackup(buffer, { actor } = {}) {
  if (!buffer || buffer.length < 100) throw new Error('That file is empty.');
  if (!buffer.subarray(0, 2).equals(GZIP_MAGIC)) {
    throw new Error('That is not a gzipped SQL dump — Astrodock backups are .sql.gz files.');
  }
  const dir = config.backups.dir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `upload-${stamp()}.sql.gz`);
  fs.writeFileSync(file, buffer);
  const [row] = await db.insert(schema.backups)
    .values({ kind: 'postgres', status: 'success', sizeBytes: buffer.length, path: file, trigger: 'uploaded' })
    .returning();
  await emitEvent({
    category: 'system', type: 'backup.uploaded', severity: 'info',
    actor: actor || 'system', targetType: 'backup', targetId: row.id,
    message: `Backup uploaded (${(buffer.length / 1048576).toFixed(1)} MB)`
  }).catch(() => {});
  return row;
}

// Add a row for any dump on disk the table does not know about.
//
// Normally a no-op. It matters straight after a restore, when the table has been
// replaced by an older one and every file written since — the safety backup most
// of all — would otherwise sit on disk unreferenced and unreachable.
async function reconcileFromDisk() {
  const dir = config.backups.dir;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql.gz')); }
  catch { return { added: 0 }; }

  const known = new Set((await db.select({ path: schema.backups.path }).from(schema.backups)).map((r) => r.path));
  const rows = [];
  for (const name of files) {
    const full = path.join(dir, name);
    if (known.has(full)) continue;
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }
    rows.push({
      kind: 'postgres', status: 'success', sizeBytes: size, path: full,
      trigger: name.startsWith('upload-') ? 'uploaded' : 'recovered',
      // Name the file after the moment it was written, so the list stays ordered
      // by when the dump was actually taken rather than when it was noticed.
      createdAt: fileStamp(name) || new Date()
    });
  }
  if (rows.length) await db.insert(schema.backups).values(rows);
  return { added: rows.length };
}

// `pg-2026-07-28T22-30-01-123Z.sql.gz` → Date. Null if the name is not ours.
function fileStamp(name) {
  const m = /^(?:pg|upload)-(.+)\.sql\.gz$/.exec(name);
  if (!m) return null;
  const iso = m[1].replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1-$2-$3T$4:$5:$6.$7Z'
  );
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function psql(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', '-i', config.backups.pgContainer,
      'psql', '-U', config.pg.user, '-d', 'postgres', ...args
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(err.trim() || `psql exited ${code}`))));

    if (stdin) { stdin.on('error', reject); stdin.pipe(child.stdin); }
    else child.stdin.end();
  });
}

// Replace the live database with the contents of a dump.
//
// This cannot run in the api process: it drops the very database that process is
// serving from. It runs on the runner, which holds the Docker socket, and the api
// is restarted afterwards so it reconnects and drops every cached value it was
// holding (settings, bootstrap routing) rather than serving stale ones.
//
// A safety dump is taken FIRST, unconditionally. Restoring the wrong file is an
// ordinary mistake and it should not be the end of the story.
async function restoreBackup({ id, actor } = {}) {
  const { row, file } = await findBackup(id);

  const safety = await runBackup({ trigger: 'pre-restore' });
  if (!safety.ok) {
    throw new Error(`Refusing to restore: the safety backup failed first (${safety.error}). `
      + 'Fix that before overwriting the database, or there is no way back.');
  }

  await emitEvent({
    category: 'system', type: 'restore.started', severity: 'warning',
    actor: actor || 'system', targetType: 'backup', targetId: id,
    message: `Restore started from ${path.basename(file)}`, meta: { safetyBackup: safety.file }
  }).catch(() => {});

  const dbName = config.pg.database;
  try {
    // Anything still holding the database open blocks the drop — including this
    // platform's own pools, which reconnect on their next query.
    await psql(['-v', 'ON_ERROR_STOP=1', '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`]);
    await psql(['-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${dbName}"`]);

    // pg_dumpall output is a cluster-level script: it recreates roles (which
    // already exist — hence ON_ERROR_STOP=0), then the database, then \connects
    // into it and reloads the data.
    const stdin = fs.createReadStream(file).pipe(zlib.createGunzip());
    await psql(['-v', 'ON_ERROR_STOP=0'], { stdin });

    // The restored database is the one from the dump, so it has no idea about
    // any file written since — including the safety backup taken moments ago,
    // whose row was just overwritten along with everything else. Without this
    // the one way back from a mistaken restore is invisible in the dashboard.
    await reconcileFromDisk().catch((e) => console.error('[backups] reconcile failed:', e.message));

    await emitEvent({
      category: 'system', type: 'restore.succeeded', severity: 'warning',
      actor: actor || 'system', targetType: 'backup', targetId: id,
      message: `Restored the database from ${path.basename(file)}`, meta: { safetyBackup: safety.file }
    }).catch(() => {});

    return { ok: true, restoredFrom: path.basename(file), safetyBackup: path.basename(safety.file), takenAt: row.createdAt };
  } catch (err) {
    await emitEvent({
      category: 'system', type: 'restore.failed', severity: 'critical',
      actor: actor || 'system', targetType: 'backup', targetId: id,
      message: `Restore FAILED: ${err.message.slice(0, 200)}`, meta: { safetyBackup: safety.file }
    }).catch(() => {});
    const e = new Error(`${err.message} — a safety backup was taken first (${path.basename(safety.file)}).`);
    e.safetyBackup = path.basename(safety.file);
    throw e;
  }
}

// Restart the api container so it picks up the restored database cleanly. Done
// after the response is sent — the caller is talking to the runner, not the api,
// so the runner survives to answer.
function restartApiSoon(delayMs = 500) {
  setTimeout(() => {
    try {
      execFileSync('docker', ['restart', config.backups.apiContainer], { timeout: 60000, stdio: 'ignore' });
    } catch (err) {
      console.error('[backups] could not restart the api container:', err.message);
    }
  }, delayMs).unref?.();
}

function startBackupScheduler() {
  const hrs = config.backups.intervalHours;
  if (!hrs || hrs <= 0) { console.log('[backups] scheduler disabled (interval 0)'); return; }
  console.log(`[backups] scheduler every ${hrs}h → ${config.backups.dir}`);
  setTimeout(() => runBackup({ trigger: 'scheduled' }).catch(() => {}), 60_000);
  setInterval(() => runBackup({ trigger: 'scheduled' }).catch(() => {}), hrs * 3600 * 1000);
}

module.exports = {
  runBackup, pruneOld, startBackupScheduler,
  findBackup, saveUploadedBackup, restoreBackup, restartApiSoon, reconcileFromDisk
};
