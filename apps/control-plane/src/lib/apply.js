'use strict';

// Reconcile the platform to match an app.json manifest. Additive and
// non-destructive: never overwrites secret VALUES, never deletes user-added env
// vars unless { prune: true }. Mirrors spec §3.2 "apply semantics".

const { eq, and } = require('drizzle-orm');
const { validate, reservedCatalog } = require('@toolstead/schema');
const { db, schema } = require('../db');
const config = require('../config');
const { generateAppSecret, generateSecretHex } = require('./ids');

async function nextPort() {
  const rows = await db.select({ port: schema.apps.port }).from(schema.apps);
  const max = rows.reduce((m, r) => Math.max(m, r.port || 0), config.basePort - 1);
  return Math.max(max + 1, config.basePort);
}

function structuralFromManifest(m) {
  return {
    name: m.name,
    description: m.description || '',
    subdomain: m.subdomain,
    runtimeType: m.runtime?.type || 'node',
    buildCommand: m.runtime?.buildCommand || 'npm run build',
    dockerfile: m.runtime?.dockerfile || 'Dockerfile',
    branch: m.source?.branch || 'main',
    repoPath: m.source?.repoPath || '',
    authMode: m.auth?.mode || 'platform',
    databaseMode: m.database?.mode || 'none',
    storageMode: m.storage?.mode || 'none'
  };
}

// Ensure the reserved external-mode rows exist (so the gate + admin UI can track
// the operator-supplied values), and drop stale ones when modes change.
async function syncReservedRows(app) {
  const modes = { auth: app.authMode, database: app.databaseMode, storage: app.storageMode };
  const wanted = reservedCatalog(modes).filter((v) => v.source === 'user-required');
  const wantedKeys = new Set(wanted.map((v) => v.key));

  const existing = await db.select().from(schema.appEnvVars)
    .where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.kind, 'reserved')));
  const existingByKey = new Map(existing.map((r) => [r.key, r]));

  for (const v of wanted) {
    if (!existingByKey.has(v.key)) {
      await db.insert(schema.appEnvVars).values({
        appId: app.id, key: v.key, value: null, isSecret: v.secret, isRequired: true,
        description: 'Required because a resource is in external mode.', kind: 'reserved'
      });
    }
  }
  for (const r of existing) {
    if (!wantedKeys.has(r.key)) {
      await db.delete(schema.appEnvVars).where(eq(schema.appEnvVars.id, r.id));
    }
  }
}

// Sync declared env var rows from manifest.env[] — upsert declaration metadata,
// preserve any already-set values. With prune, remove declared rows not present
// in the manifest.
async function syncDeclaredRows(app, declared, prune) {
  const manifestKeys = new Set(declared.map((e) => e.key));
  const existing = await db.select().from(schema.appEnvVars)
    .where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.kind, 'declared')));
  const byKey = new Map(existing.map((r) => [r.key, r]));

  for (const e of declared) {
    const meta = {
      isSecret: !!e.secret,
      isRequired: !!e.required,
      defaultValue: e.secret ? null : (e.default ?? null),
      description: e.description || '',
      updatedAt: new Date()
    };
    if (byKey.has(e.key)) {
      await db.update(schema.appEnvVars).set(meta)
        .where(eq(schema.appEnvVars.id, byKey.get(e.key).id));
    } else {
      await db.insert(schema.appEnvVars).values({ appId: app.id, key: e.key, value: null, kind: 'declared', ...meta });
    }
  }

  if (prune) {
    for (const r of existing) {
      if (!manifestKeys.has(r.key)) {
        await db.delete(schema.appEnvVars).where(eq(schema.appEnvVars.id, r.id));
      }
    }
  }
}

/**
 * Apply a parsed app.json manifest.
 * @returns {Promise<{ app: object, created: boolean }>}
 * @throws {Error} with .status + .errors on validation failure
 */
async function applyManifest(manifest, { prune = false } = {}) {
  const { valid, errors } = validate(manifest);
  if (!valid) {
    const err = new Error('app.json failed validation');
    err.status = 400; err.errors = errors;
    throw err;
  }

  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, manifest.slug)).limit(1);
  let app = rows[0];
  let created = false;

  if (!app) {
    // subdomain uniqueness
    const subClash = await db.select().from(schema.apps).where(eq(schema.apps.subdomain, manifest.subdomain)).limit(1);
    if (subClash[0]) {
      const err = new Error(`subdomain "${manifest.subdomain}" is already in use`);
      err.status = 409; throw err;
    }
    const inserted = await db.insert(schema.apps).values({
      slug: manifest.slug,
      port: await nextPort(),
      appSecret: generateAppSecret(),
      appJwtSecret: generateSecretHex(32),
      ...structuralFromManifest(manifest)
    }).returning();
    app = inserted[0];
    created = true;
  } else {
    const updated = await db.update(schema.apps)
      .set({ ...structuralFromManifest(manifest), updatedAt: new Date() })
      .where(eq(schema.apps.id, app.id)).returning();
    app = updated[0];
  }

  await syncReservedRows(app);
  await syncDeclaredRows(app, manifest.env || [], prune);

  return { app, created };
}

module.exports = { applyManifest, nextPort };
