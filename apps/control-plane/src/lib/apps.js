'use strict';

const { eq, asc } = require('drizzle-orm');
const { db, schema } = require('../db');

async function getAppBySlug(slug) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, slug)).limit(1);
  return rows[0] || null;
}

async function getAppEnvVars(appId) {
  return db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, appId)).orderBy(asc(schema.appEnvVars.key));
}

// Public projection of an app row — never leaks generated secrets.
function serializeApp(app) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    subdomain: app.subdomain,
    port: app.port,
    runtime: { type: app.runtimeType, buildCommand: app.buildCommand, dockerfile: app.dockerfile },
    source: { branch: app.branch, repoPath: app.repoPath, githubRepo: app.githubRepo },
    auth: { mode: app.authMode },
    database: { mode: app.databaseMode },
    storage: { mode: app.storageMode },
    repoConnected: !!app.githubRepo,
    webhookConnected: !!app.webhookId,
    provisioned: app.provisioned,
    internal: {
      dbName: app.databaseMode === 'internal' ? app.dbName : null,
      storagePrefix: app.storageMode === 'internal' ? app.storagePrefix : null
    },
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

// Env var projection — secret values are masked (set→•••••• / unset→null).
function serializeEnvVar(v) {
  const isSet = v.value != null && v.value !== '';
  return {
    key: v.key,
    value: v.isSecret ? (isSet ? '••••••' : null) : (isSet ? v.value : null),
    isSecret: v.isSecret,
    required: v.isRequired,
    default: v.defaultValue || null,
    description: v.description || '',
    kind: v.kind,
    isSet: isSet || (!v.isSecret && !!v.defaultValue)
  };
}

module.exports = { getAppBySlug, getAppEnvVars, serializeApp, serializeEnvVar };
