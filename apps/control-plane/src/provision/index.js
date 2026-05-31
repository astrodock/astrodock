'use strict';

const fs = require('fs');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { provisionDatabase } = require('./database');
const { provisionStorage } = require('./storage');
const { generateCaddyfile, loadCaddyfile } = require('./caddy');

// Regenerate the full Caddy config from all provisioned apps and push it.
async function reloadCaddyFromDb() {
  const provisioned = await db.select().from(schema.apps).where(eq(schema.apps.provisioned, true));
  return loadCaddyfile(generateCaddyfile(provisioned));
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
    const r = await provisionStorage(app);
    update.storagePrefix = r.storagePrefix;
    results.push(`internal storage prefix "${r.storagePrefix}" ready in bucket "${config.objectstore.bucket}"`);
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

module.exports = { provisionApp, unprovisionApp, reloadCaddyFromDb };
