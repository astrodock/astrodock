'use strict';

const config = require('../config');
const { userRequiredReservedKeys } = require('@toolstead/schema');
const { decryptSecret } = require('./crypto');

function scheme() {
  return config.tlsMode === 'off' ? 'http' : 'https';
}

function appUrl(app) {
  return `${scheme()}://${app.subdomain}.${config.baseDomain}`;
}

function modesOf(app) {
  return { auth: app.authMode, database: app.databaseMode, storage: app.storageMode };
}

function valueMap(envVars) {
  const m = new Map();
  for (const v of envVars) m.set(v.key, v.value);
  return m;
}

/**
 * Compute the full runtime environment for an app: reserved TOOLSTEAD_* vars
 * (from resource modes + stack config + the app's provisioned state) + declared
 * vars (value or default) + the documented PORT alias.
 *
 * @param {object} app          apps row
 * @param {object[]} envVars    app_env_vars rows
 * @returns {Record<string,string>}
 */
function computeEnv(app, envVars) {
  const env = {};
  const vals = valueMap(envVars);

  // ── always-on reserved ──
  env.TOOLSTEAD_APP_SLUG = app.slug;
  env.TOOLSTEAD_APP_NAME = app.name;
  env.TOOLSTEAD_APP_URL = appUrl(app);
  env.TOOLSTEAD_BASE_DOMAIN = config.baseDomain;
  env.TOOLSTEAD_PORT = String(app.port);
  env.TOOLSTEAD_ENV = config.env;

  // ── database ──
  if (app.databaseMode === 'internal') {
    const u = encodeURIComponent(app.dbUser || '');
    const p = encodeURIComponent(decryptSecret(app.dbPassword) || '');
    env.TOOLSTEAD_DATABASE_URL = `postgresql://${u}:${p}@${config.pg.appHost}:${config.pg.appPort}/${app.dbName}`;
    env.TOOLSTEAD_DATABASE_ENGINE = 'postgres';
  } else if (app.databaseMode === 'external') {
    const v = vals.get('TOOLSTEAD_DATABASE_URL');
    if (v) env.TOOLSTEAD_DATABASE_URL = decryptSecret(v);
    env.TOOLSTEAD_DATABASE_ENGINE = 'postgres';
  }

  // ── storage ──
  if (app.storageMode === 'internal') {
    env.TOOLSTEAD_STORAGE_ENDPOINT = config.objectstore.appEndpoint;
    env.TOOLSTEAD_STORAGE_REGION = config.objectstore.region;
    if (app.storageAccessKey) {
      // scoped per-app key + own bucket
      env.TOOLSTEAD_STORAGE_BUCKET = app.storageBucket;
      env.TOOLSTEAD_STORAGE_PREFIX = app.storagePrefix || '';
      env.TOOLSTEAD_STORAGE_ACCESS_KEY = app.storageAccessKey;
      env.TOOLSTEAD_STORAGE_SECRET_KEY = decryptSecret(app.storageSecretKey);
    } else {
      // shared-key fallback + per-app prefix
      env.TOOLSTEAD_STORAGE_BUCKET = config.objectstore.bucket;
      env.TOOLSTEAD_STORAGE_PREFIX = app.storagePrefix || `${app.slug}/`;
      env.TOOLSTEAD_STORAGE_ACCESS_KEY = config.objectstore.accessKey;
      env.TOOLSTEAD_STORAGE_SECRET_KEY = config.objectstore.secretKey;
    }
  } else if (app.storageMode === 'external') {
    for (const k of ['TOOLSTEAD_STORAGE_ENDPOINT', 'TOOLSTEAD_STORAGE_REGION', 'TOOLSTEAD_STORAGE_BUCKET', 'TOOLSTEAD_STORAGE_ACCESS_KEY', 'TOOLSTEAD_STORAGE_SECRET_KEY']) {
      if (vals.get(k)) env[k] = decryptSecret(vals.get(k));
    }
  }

  // ── auth ──
  if (app.authMode === 'platform') {
    env.TOOLSTEAD_AUTH_URL = config.internalAuthUrl;
    env.TOOLSTEAD_APP_ID = app.slug;
    env.TOOLSTEAD_APP_SECRET = decryptSecret(app.appSecret);
    env.TOOLSTEAD_APP_JWT_SECRET = decryptSecret(app.appJwtSecret);
  }

  // ── app-declared (value or default; secrets never have defaults) ──
  for (const v of envVars) {
    if (v.kind !== 'declared') continue;
    const raw = (v.value != null && v.value !== '') ? decryptSecret(v.value) : (v.defaultValue ?? null);
    if (raw != null) env[v.key] = raw;
  }

  // ── documented unprefixed alias ──
  env.PORT = env.TOOLSTEAD_PORT;

  return env;
}

/**
 * Required-variable gate. Returns the list of variables that must have a value
 * before a deploy may start. Empty list = good to deploy.
 *
 * @returns {Array<{key:string, kind:'declared'|'reserved', reason:string}>}
 */
function computeMissingRequired(app, envVars) {
  const missing = [];
  const vals = valueMap(envVars);

  // (a) declared required vars with neither a value nor a default
  for (const v of envVars) {
    if (v.kind !== 'declared' || !v.isRequired) continue;
    const hasValue = v.value != null && v.value !== '';
    const hasDefault = v.defaultValue != null && v.defaultValue !== '';
    if (!hasValue && !hasDefault) {
      missing.push({ key: v.key, kind: 'declared', reason: 'required app variable has no value' });
    }
  }

  // (b) external-mode reserved vars the operator must supply
  for (const key of userRequiredReservedKeys(modesOf(app))) {
    const val = vals.get(key);
    if (!val) missing.push({ key, kind: 'reserved', reason: 'required for external-mode resource' });
  }

  return missing;
}

module.exports = { computeEnv, computeMissingRequired, appUrl, modesOf };
