'use strict';

const config = require('../config');
const { userRequiredReservedKeys } = require('@astrodock/schema');
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
 * Compute the full runtime environment for an app: reserved ASTRODOCK_* vars
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
  env.ASTRODOCK_APP_SLUG = app.slug;
  env.ASTRODOCK_APP_NAME = app.name;
  env.ASTRODOCK_APP_URL = appUrl(app);
  env.ASTRODOCK_BASE_DOMAIN = config.baseDomain;
  env.ASTRODOCK_PORT = String(app.port);
  env.ASTRODOCK_ENV = config.env;

  // ── database ──
  if (app.databaseMode === 'internal') {
    const u = encodeURIComponent(app.dbUser || '');
    const p = encodeURIComponent(decryptSecret(app.dbPassword) || '');
    env.ASTRODOCK_DATABASE_URL = `postgresql://${u}:${p}@${config.pg.appHost}:${config.pg.appPort}/${app.dbName}`;
    env.ASTRODOCK_DATABASE_ENGINE = 'postgres';
  } else if (app.databaseMode === 'external') {
    const v = vals.get('ASTRODOCK_DATABASE_URL');
    if (v) env.ASTRODOCK_DATABASE_URL = decryptSecret(v);
    env.ASTRODOCK_DATABASE_ENGINE = 'postgres';
  }

  // ── storage ──
  if (app.storageMode === 'internal') {
    env.ASTRODOCK_STORAGE_ENDPOINT = config.objectstore.appEndpoint;
    env.ASTRODOCK_STORAGE_REGION = config.objectstore.region;
    if (app.storageAccessKey) {
      // scoped per-app key + own bucket
      env.ASTRODOCK_STORAGE_BUCKET = app.storageBucket;
      env.ASTRODOCK_STORAGE_PREFIX = app.storagePrefix || '';
      env.ASTRODOCK_STORAGE_ACCESS_KEY = app.storageAccessKey;
      env.ASTRODOCK_STORAGE_SECRET_KEY = decryptSecret(app.storageSecretKey);
    } else {
      // shared-key fallback + per-app prefix
      env.ASTRODOCK_STORAGE_BUCKET = config.objectstore.bucket;
      env.ASTRODOCK_STORAGE_PREFIX = app.storagePrefix || `${app.slug}/`;
      env.ASTRODOCK_STORAGE_ACCESS_KEY = config.objectstore.accessKey;
      env.ASTRODOCK_STORAGE_SECRET_KEY = config.objectstore.secretKey;
    }
  } else if (app.storageMode === 'external') {
    for (const k of ['ASTRODOCK_STORAGE_ENDPOINT', 'ASTRODOCK_STORAGE_REGION', 'ASTRODOCK_STORAGE_BUCKET', 'ASTRODOCK_STORAGE_ACCESS_KEY', 'ASTRODOCK_STORAGE_SECRET_KEY']) {
      if (vals.get(k)) env[k] = decryptSecret(vals.get(k));
    }
  }

  // ── auth ──
  if (app.authMode === 'platform') {
    // Two URLs, because they are reached by two different things.
    //
    // ASTRODOCK_AUTH_URL is internal (http://api:3100) and is right for the
    // server-to-server code exchange: it never leaves the box. But the app was
    // also told to send the USER'S BROWSER to `${ASTRODOCK_AUTH_URL}/authorize`,
    // and a browser cannot resolve "api" — it is a Docker network name. Every app
    // that followed the documented pattern had an unreachable sign-in.
    env.ASTRODOCK_AUTH_URL = config.internalAuthUrl;
    const publicAuth = config.authBaseUrl();
    if (publicAuth) {
      env.ASTRODOCK_AUTHORIZE_URL = `${publicAuth}/authorize`;
      // Ends the platform session only — it cannot clear an app's own cookie.
      env.ASTRODOCK_LOGOUT_URL = `${publicAuth}/logout`;
    }
    env.ASTRODOCK_APP_ID = app.slug;
    env.ASTRODOCK_APP_SECRET = decryptSecret(app.appSecret);
    env.ASTRODOCK_APP_JWT_SECRET = decryptSecret(app.appJwtSecret);
  }

  // ── app-declared (value or default; secrets never have defaults) ──
  for (const v of envVars) {
    if (v.kind !== 'declared') continue;
    const raw = (v.value != null && v.value !== '') ? decryptSecret(v.value) : (v.defaultValue ?? null);
    if (raw != null) env[v.key] = raw;
  }

  // ── documented unprefixed alias ──
  env.PORT = env.ASTRODOCK_PORT;

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
