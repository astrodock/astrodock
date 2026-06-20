'use strict';

const fs = require('fs');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { provisionDatabase } = require('./database');
const { runner } = require('../runner/client');
const { generateCaddyfile, loadCaddyfile } = require('./caddy');
const { getSetting } = require('../lib/settings');

// Regenerate the full Caddy config from all provisioned apps and push it.
async function reloadCaddyFromDb() {
  const provisioned = await db.select().from(schema.apps).where(eq(schema.apps.provisioned, true));
  const accessLogs = (await getSetting('logging.app_access_logs', 'off')) === 'on';
  return loadCaddyfile(generateCaddyfile(provisioned, { accessLogs }));
}

// Push with a few retries + backoff — Caddy may still be booting on cold start.
async function reloadCaddyWithRetry(attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    if (await reloadCaddyFromDb()) return true;
    await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 15000)));
  }
  console.error('[caddy] could not push routing after retries — the reconciler will keep trying');
  return false;
}

// Periodic self-heal: re-push routing so a transient failure (or a Caddy restart
// that lost the dynamic config) recovers without operator action.
function startCaddyReconciler(intervalMs = 120000) {
  setInterval(() => { reloadCaddyFromDb().catch(() => {}); }, intervalMs);
}

// Provision an app's resources from its modes and (re)configure routing.
// Idempotent. Does NOT drop data when modes change (destructive-by-omission).
async function provisionApp(app) {
  const results = [];
  const update = { provisioned: true, updatedAt: new Date() };

  // Ensure runner working dirs exist (node buildpack writes here).
  for (const dir of [config.paths.static, config.paths.apps, config.paths.repos]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* may be read-only here; runner has them */ }
  }

  if (app.databaseMode === 'internal') {
    const r = await provisionDatabase(app);
    update.dbName = r.dbName; update.dbUser = r.dbUser; update.dbPassword = r.dbPassword;
    results.push(`internal database "${r.dbName}" ready`);
  }

  if (app.storageMode === 'internal') {
    // storage-identity provisioning needs the Docker socket → delegate to the runner
    const resp = await runner.provisionStorage(app.slug);
    if (resp.status !== 200) throw new Error(`runner storage provisioning failed: ${resp.body?.error || resp.status}`);
    const r = resp.body;
    update.storageBucket = r.storageBucket;
    update.storagePrefix = r.storagePrefix;
    update.storageAccessKey = r.storageAccessKey;
    update.storageSecretKey = r.storageSecretKey;
    results.push(r.scoped
      ? `internal storage: scoped key on bucket "${r.storageBucket}"`
      : `internal storage: shared key + prefix "${r.storagePrefix}" in bucket "${r.storageBucket}" (scoped keys unavailable)`);
  }

  const rows = await db.update(schema.apps).set(update).where(eq(schema.apps.id, app.id)).returning();
  const updated = rows[0];

  const ok = await reloadCaddyFromDb();
  results.push(ok ? 'Caddy reconfigured' : 'Caddy reload skipped (admin API unreachable) — retry on next provision');

  return { app: updated, results };
}

// Remove an app from routing. Internal DB/storage data is intentionally NOT
// deleted (avoids accidental data loss); orphans can be dropped manually.
async function unprovisionApp() {
  return reloadCaddyFromDb();
}

module.exports = { provisionApp, unprovisionApp, reloadCaddyFromDb, reloadCaddyWithRetry, startCaddyReconciler };
