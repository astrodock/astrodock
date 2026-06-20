'use strict';

// Operator-editable platform settings, with env defaults.
//
// Two-tier config model (see BUILD_PLAN.md Phase 6):
//   • Infra / bootstrap config (PG creds, secret key, domain, ports, …) stays
//     ENV-ONLY and is shown read-only via diagnostics() — dangerous to mutate at
//     runtime, and several values are only read at boot.
//   • Operational settings (below) take their DEFAULT from env/config but may be
//     OVERRIDDEN at runtime and stored in `platform_settings`. Precedence:
//     stored override  >  env/config default.
//
// Reads are cached briefly (settings change rarely, but are read on hot-ish paths
// like log retention). The cache is per-process; with a short TTL a write in one
// process (api vs runner) becomes visible to the other within TTL.

const { db, schema } = require('../db');
const config = require('../config');

// The registry is the allowlist of editable keys. `default` is a thunk so it
// reflects the current env/config at read time.
const REGISTRY = {
  'alerts.email_to': {
    label: 'Alert recipient', type: 'string',
    default: () => config.email.alertTo || ''
  },
  'alerts.email_from': {
    label: 'Email “from” address', type: 'string',
    default: () => config.email.from
  },
  'logging.page_view_ip': {
    label: 'Store visitor IPs in page access logs', type: 'enum',
    values: ['full', 'truncated', 'off'], default: () => 'full'
  },
  'logging.auth_log_retention_days': {
    label: 'Auth-log retention (days)', type: 'int',
    default: () => 90
  }
};

let cache = null;
let loadedAt = 0;
const TTL_MS = 15_000;

async function loadOverrides() {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    const rows = await db.select().from(schema.platformSettings);
    cache = new Map(rows.map((r) => [r.key, r.value]));
    loadedAt = Date.now();
  } catch (err) {
    console.error('[settings] load failed:', err.message);
    if (!cache) cache = new Map(); // serve defaults until the table is reachable
  }
  return cache;
}

function defaultFor(key) {
  const def = REGISTRY[key];
  return def ? def.default() : undefined;
}

function coerce(key, value) {
  const def = REGISTRY[key];
  if (!def) return value;
  if (def.type === 'int') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) throw new Error(`${key} must be an integer`);
    return n;
  }
  if (def.type === 'enum' && !def.values.includes(value)) {
    throw new Error(`${key} must be one of: ${def.values.join(', ')}`);
  }
  return value;
}

// Resolve a setting: stored override if present, else the env/config default,
// else the caller-supplied fallback.
async function getSetting(key, fallback) {
  const overrides = await loadOverrides();
  if (overrides.has(key)) return overrides.get(key);
  const d = defaultFor(key);
  return d === undefined ? fallback : d;
}

async function setSetting(key, value, actor) {
  if (!REGISTRY[key]) throw new Error(`unknown setting: ${key}`);
  const v = coerce(key, value);
  const row = { key, value: v, updatedBy: actor || '', updatedAt: new Date() };
  await db.insert(schema.platformSettings).values(row)
    .onConflictDoUpdate({ target: schema.platformSettings.key, set: row });
  cache = null; // invalidate this process immediately
  return v;
}

// The full operational set with effective values + source, for the Settings UI.
async function effective() {
  const overrides = await loadOverrides();
  return Object.entries(REGISTRY).map(([key, def]) => {
    const has = overrides.has(key);
    return {
      key,
      label: def.label,
      type: def.type,
      values: def.values || null,
      value: has ? overrides.get(key) : def.default(),
      source: has ? 'override' : 'default'
    };
  });
}

const mask = (v) => (v ? '••• set' : 'not set');

// Read-only view of infra/bootstrap config so an operator can confirm effective
// settings without SSHing into the box. Secrets are masked, never returned.
function diagnostics() {
  const { isEnabled } = require('./crypto');
  return {
    env: config.env,
    baseDomain: config.baseDomain,
    adminSubdomain: config.adminSubdomain,
    pagesHost: config.pages.host,
    tlsMode: config.tlsMode,
    port: config.port,
    basePort: config.basePort,
    postgres: { host: config.pg.host, port: config.pg.port, database: config.pg.database, password: mask(config.pg.password) },
    objectstore: { endpoint: config.objectstore.endpoint, bucket: config.objectstore.bucket, accessKey: mask(config.objectstore.accessKey) },
    email: { from: config.email.from, resendConfigured: !!config.email.resendApiKey, alertTo: config.email.alertTo || '(unset)' },
    github: { owner: config.github.owner || '(unset)', pat: mask(config.github.pat) },
    runner: { url: config.runnerUrl, token: mask(config.runnerToken) },
    features: { terminal: config.enableTerminal, secretEncryption: isEnabled() }
  };
}

// Boot-time nudges toward a production-ready config.
function readiness() {
  const { isEnabled } = require('./crypto');
  const enc = isEnabled();
  const hasAlert = !!config.email.alertTo;
  const hasEmail = !!config.email.resendApiKey;
  return [
    { key: 'secret_encryption', ok: enc, level: enc ? 'ok' : 'critical',
      message: enc ? 'Secrets are encrypted at rest.' : 'ASTRODOCK_SECRET_KEY is not set — secrets are stored in plaintext.' },
    { key: 'alert_email', ok: hasAlert, level: hasAlert ? 'ok' : 'warning',
      message: hasAlert ? 'Alert recipient is configured.' : 'No alert recipient set — health/deploy alerts have nowhere to go.' },
    { key: 'email_provider', ok: hasEmail, level: hasEmail ? 'ok' : 'warning',
      message: hasEmail ? 'Email delivery is configured.' : 'No email provider (ASTRODOCK_RESEND_API_KEY) — email alerts will not send.' }
  ];
}

module.exports = { getSetting, setSetting, effective, diagnostics, readiness, REGISTRY };
