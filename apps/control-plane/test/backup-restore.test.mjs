// Backup → download → upload → restore, against a throwaway Postgres container.
//
// Restore is the one operation in the platform that destroys data on purpose, so
// it gets exercised for real rather than mocked: take a dump, change the data,
// restore, and check the change is gone.
//
// Requires Docker and a container named by ASTRODOCK_PG_CONTAINER. The runner
// script (test/with-restore-pg.sh) creates and removes it. Skipped when absent.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CONTAINER = process.env.ASTRODOCK_PG_CONTAINER || 'adock-restore-test';
function containerUp() {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' }).trim() === 'true';
  } catch { return false; }
}
if (!containerUp()) {
  console.log(`backup/restore: skipped — no running container named ${CONTAINER}`);
  process.exit(0);
}

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-backups-'));
process.env.ASTRODOCK_BACKUP_DIR = backupDir;
process.env.ASTRODOCK_BACKUP_INTERVAL_HOURS = '0';   // no scheduler during a test
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';

const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const backups = require('../src/lib/backups.js');
const { eq, sql } = require('drizzle-orm');

// This test drops a database. It reaches Postgres two different ways — a client
// connection for the assertions, and `docker exec` for the dump and restore — and
// nothing about the configuration guarantees those are the same server. Point
// ASTRODOCK_PG_HOST at one machine and ASTRODOCK_PG_CONTAINER at another and it
// would happily drop a database it was never asked to touch.
//
// Every cluster reports a unique system_identifier. If the two paths do not agree
// on it, refuse to run at all.
async function assertSameCluster() {
  const viaClient = (await db.execute(sql`SELECT system_identifier FROM pg_control_system()`))[0]?.system_identifier;
  const viaDocker = execFileSync('docker', [
    'exec', CONTAINER, 'psql', '-U', process.env.ASTRODOCK_PG_USER || 'astrodock',
    '-d', 'postgres', '-t', '-A', '-c', 'SELECT system_identifier FROM pg_control_system()'
  ], { encoding: 'utf8' }).trim();

  if (String(viaClient) !== String(viaDocker)) {
    console.error(
      'backup/restore: REFUSING TO RUN.\n'
      + `  the client connects to cluster ${viaClient}\n`
      + `  but container "${CONTAINER}" is cluster ${viaDocker}\n`
      + '  Restoring would drop a database this test was not pointed at.'
    );
    process.exit(1);
  }
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

console.log('backup / restore');

try {
  await assertSameCluster();
  await migrate();
  await db.delete(schema.backups);
  await db.delete(schema.apps);

  const MARKER = 'before-the-backup';
  const app = (slug, port) => ({
    slug, name: slug, subdomain: slug, port,
    appSecret: `secret-${slug}`, appJwtSecret: `jwt-${slug}`
  });
  await db.insert(schema.apps).values(app(MARKER, 39001));

  let saved;
  await test('a backup produces a real gzipped dump on disk', async () => {
    const r = await backups.runBackup({ trigger: 'manual' });
    assert.ok(r.ok, `backup failed: ${r.error}`);
    assert.ok(r.size > 100, 'dump is suspiciously small');
    const magic = fs.readFileSync(r.file).subarray(0, 2);
    assert.deepStrictEqual([...magic], [0x1f, 0x8b], 'not gzip');
    const rows = await db.select().from(schema.backups);
    saved = rows.find((x) => x.path === r.file);
    assert.ok(saved, 'no row recorded for the dump');
    assert.strictEqual(saved.status, 'success');
  });

  await test('findBackup refuses a path outside the backups directory', async () => {
    const [row] = await db.insert(schema.backups)
      .values({ kind: 'postgres', status: 'success', sizeBytes: 999, path: '/etc/passwd', trigger: 'manual' })
      .returning();
    await assert.rejects(() => backups.findBackup(row.id), /outside the backups directory/);
    await db.delete(schema.backups).where(eq(schema.backups.id, row.id));
  });

  await test('an upload has to actually be a gzip', async () => {
    await assert.rejects(() => backups.saveUploadedBackup(Buffer.alloc(200, 0x41)), /not a gzipped SQL dump/);
    await assert.rejects(() => backups.saveUploadedBackup(Buffer.alloc(4)), /empty/);
  });

  await test('an uploaded dump is stored and listed', async () => {
    const buf = fs.readFileSync(saved.path);
    const row = await backups.saveUploadedBackup(buf, { actor: 'test' });
    assert.strictEqual(row.trigger, 'uploaded');
    assert.ok(path.basename(row.path).startsWith('upload-'), 'uploads need their own prefix');
    assert.ok(fs.existsSync(row.path));
  });

  await test('pruning drops old scheduled dumps but leaves uploads alone', async () => {
    // pruneOld only ever considers `pg-` files, so an upload someone deliberately
    // carried in survives a prune that would otherwise sweep it up. Keep enough
    // room for the dumps already on disk so this does not eat the fixture.
    const uploads = fs.readdirSync(backupDir).filter((f) => f.startsWith('upload-'));
    const existing = fs.readdirSync(backupDir).filter((f) => f.startsWith('pg-'));
    const stale = path.join(backupDir, 'pg-1970-01-01T00-00-00-000Z.sql.gz');
    fs.writeFileSync(stale, Buffer.from([0x1f, 0x8b]));

    await backups.pruneOld(backupDir, existing.length);

    assert.ok(!fs.existsSync(stale), 'the oldest dump should have been pruned');
    for (const f of existing) assert.ok(fs.existsSync(path.join(backupDir, f)), `${f} was pruned too eagerly`);
    for (const f of uploads) assert.ok(fs.existsSync(path.join(backupDir, f)), `${f} was pruned`);
  });

  await test('restoring brings back the data as of the dump', async () => {
    // Change the world after the backup was taken...
    await db.delete(schema.apps).where(eq(schema.apps.slug, MARKER));
    await db.insert(schema.apps).values(app('after', 39002));
    const before = await db.select().from(schema.apps);
    assert.ok(!before.some((a) => a.slug === MARKER), 'setup failed: marker still present');

    const result = await backups.restoreBackup({ id: saved.id, actor: 'test' });
    assert.ok(result.ok);
    assert.ok(result.safetyBackup, 'a safety backup should have been taken first');

    // ...and check the restore undid it. The pool reconnects to the recreated DB.
    const after = await db.select().from(schema.apps);
    assert.ok(after.some((a) => a.slug === MARKER), 'the restored row is missing');
    assert.ok(!after.some((a) => a.slug === 'after'), 'a row created after the dump survived the restore');
  });

  await test('the safety backup survives the restore that created it', async () => {
    // The restore replaces the backups table with the dump's older copy, so the
    // safety backup's own row goes with it. If it is not put back, the only way
    // out of a mistaken restore is invisible in the dashboard.
    const rows = await db.select().from(schema.backups);
    const safety = rows.find((r) => path.basename(r.path).startsWith('pg-') && r.trigger === 'recovered')
      || rows.find((r) => r.trigger === 'pre-restore');
    assert.ok(safety, 'the safety backup is not listed after the restore');
    const { file } = await backups.findBackup(safety.id);
    assert.ok(fs.statSync(file).size > 100);
  });

  await test('reconciling is a no-op when nothing is missing', async () => {
    const { added } = await backups.reconcileFromDisk();
    assert.strictEqual(added, 0);
  });

  await test('an orphaned dump on disk is recovered into the list', async () => {
    const orphan = path.join(backupDir, 'pg-2020-01-02T03-04-05-006Z.sql.gz');
    fs.writeFileSync(orphan, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(300)]));
    const { added } = await backups.reconcileFromDisk();
    assert.strictEqual(added, 1);
    const row = (await db.select().from(schema.backups)).find((r) => r.path === orphan);
    assert.ok(row, 'no row created for the orphan');
    assert.strictEqual(row.trigger, 'recovered');
    // The name carries the timestamp; the list must order by that, not by now.
    assert.strictEqual(new Date(row.createdAt).toISOString(), '2020-01-02T03:04:05.006Z');
  });
} finally {
  await close().catch(() => {});
  fs.rmSync(backupDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
