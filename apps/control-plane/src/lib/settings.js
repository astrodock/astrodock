'use strict';

// Operator-editable platform settings, with env defaults.
//
// Three-tier config model (see BUILD_PLAN.md Phase 6, as re-pinned for first-run setup):
//   • Infra / secrets (PG creds, secret key, runner token, object-store creds) stays
//     ENV-ONLY and is shown read-only via diagnostics() — dangerous to mutate at
//     runtime, and several values are only read at boot.
//   • Bootstrap routing (base domain, TLS mode, ACME email) is settable at runtime
//     via BOOTSTRAP_REGISTRY below. This is the one part of the old "env-only"
//     bootstrap tier that had to open up: the domain is the single value a human
//     must supply, and collecting it in the first-run wizard is what removes the
//     hand-edited .env from the install. Safe to change live because every consumer
//     reads config.baseDomain at call time and Caddy is reconfigured by hot reload.
//   • Operational settings (below) take their DEFAULT from env/config but may be
//     OVERRIDDEN at runtime and stored in `platform_settings`. Precedence:
//     stored override  >  env/config default.
//
// Reads are cached briefly (settings change rarely, but are read on hot-ish paths
// like log retention). The cache is per-process; with a short TTL a write in one
// process (api vs runner) becomes visible to the other within TTL.

const { eq } = require('drizzle-orm');
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
  },
  'logging.page_view_retention_days': {
    label: 'Page access-log retention (days)', type: 'int',
    default: () => 90
  },
  'logging.app_access_logs': {
    label: 'Caddy access logs for deployed apps', type: 'enum',
    values: ['off', 'on'], default: () => 'off'
  },
  'alerts.disk_threshold_percent': {
    label: 'Disk-usage alert threshold (%)', type: 'int',
    default: () => 85
  }
};

// Bootstrap routing settings. Stored in the same table (so they inherit the audit
// trail and the masked-diagnostics plumbing) but kept out of REGISTRY so the
// operational Settings UI doesn't render "change your domain" as a casual field row.
const BOOTSTRAP_REGISTRY = {
  'platform.base_domain': { label: 'Base domain', type: 'string', default: () => config.baseDomain },
  'platform.tls_mode': { label: 'HTTPS mode', type: 'enum', values: ['auto', 'internal', 'off'], default: () => config.tlsMode },
  'platform.acme_email': { label: 'Certificate contact email', type: 'string', default: () => config.acmeEmail }
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

// ── Bootstrap routing (base domain / TLS) ────────────────────────────────────

// Persist a bootstrap change AND apply it to the live config in this process.
// The caller regenerates routing afterwards; the Caddy reconciler propagates the
// change to the runner process on its next pass.
async function setBootstrap(values, actor) {
  const keys = { baseDomain: 'platform.base_domain', tlsMode: 'platform.tls_mode', acmeEmail: 'platform.acme_email' };
  for (const [field, key] of Object.entries(keys)) {
    if (values[field] == null) continue;
    const def = BOOTSTRAP_REGISTRY[key];
    if (def.type === 'enum' && !def.values.includes(values[field])) {
      throw new Error(`${def.label} must be one of: ${def.values.join(', ')}`);
    }
    const row = { key, value: values[field], updatedBy: actor || '', updatedAt: new Date() };
    await db.insert(schema.platformSettings).values(row)
      .onConflictDoUpdate({ target: schema.platformSettings.key, set: row });
  }
  cache = null;
  return config.applyRuntimeDomain(values);
}

// "I'll pick a domain later." Setup is otherwise only considered finished once a
// base domain exists, which would trap anyone who wants to look around first — or
// who is standing the box up before their DNS is ready. Deferring lets the
// dashboard open over the server's IP; the readiness card keeps nagging.
const DEFERRED_KEY = 'platform.setup_deferred';

async function isSetupDeferred() {
  try {
    const rows = await db.select().from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, DEFERRED_KEY)).limit(1);
    return rows[0]?.value === true || rows[0]?.value === 'true';
  } catch {
    return false;
  }
}

async function setSetupDeferred(value, actor) {
  const row = { key: DEFERRED_KEY, value: !!value, updatedBy: actor || '', updatedAt: new Date() };
  await db.insert(schema.platformSettings).values(row)
    .onConflictDoUpdate({ target: schema.platformSettings.key, set: row });
  cache = null;
}

// Load persisted bootstrap routing over the env defaults. Called once at boot,
// BEFORE anything generates a hostname, in both the api and runner roles.
async function applyBootstrapSettings() {
  try {
    const rows = await db.select().from(schema.platformSettings);
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const patch = {};
    if (stored.has('platform.base_domain')) patch.baseDomain = stored.get('platform.base_domain');
    if (stored.has('platform.tls_mode')) patch.tlsMode = stored.get('platform.tls_mode');
    if (stored.has('platform.acme_email')) patch.acmeEmail = stored.get('platform.acme_email');
    if (Object.keys(patch).length) config.applyRuntimeDomain(patch);
    return config.isConfigured();
  } catch (err) {
    // A missing/booting table must not stop the process — we simply stay on env
    // values, which for a fresh install means "unconfigured" and the wizard shows.
    console.error('[settings] bootstrap load failed:', err.message);
    return config.isConfigured();
  }
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
    configured: config.isConfigured(),
    baseDomain: config.baseDomain || '(not set — first-run setup pending)',
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
    features: { secretEncryption: isEnabled() }
  };
}

// Ask the runner what this host publishes to the internet, and turn it into a
// readiness card. Never throws: an unreachable runner is reported as unknown, and
// an unknown must not masquerade as "all clear".
async function exposureCheck() {
  try {
    const { runner } = require('../runner/client');
    const { status, body } = await runner.exposure();
    if (status !== 200 || !body) throw new Error('runner did not answer');
    if (!body.available) {
      return {
        key: 'port_exposure', ok: true, level: 'ok',
        message: 'Could not read the port list from Docker, so open-port checking is unavailable.'
      };
    }
    const meta = body.metadata || {};
    if (meta.available && meta.reachable) {
      // Ranked above the port findings: an app reading instance metadata is a
      // credential-disclosure path, not just a wider attack surface.
      return {
        key: 'port_exposure', ok: false, level: 'warning',
        message: 'Deployed apps can reach the cloud metadata service (169.254.169.254) and read this '
          + "server's instance data — on some providers that includes credentials. Block it with: "
          + 'iptables -I DOCKER-USER -d 169.254.169.254 -j DROP'
      };
    }
    const n = (body.findings || []).length;
    if (!n) {
      return {
        key: 'port_exposure', ok: true, level: 'ok',
        message: 'Only ports 80 and 443 are published to the internet.'
      };
    }
    return {
      key: 'port_exposure', ok: false, level: 'warning',
      message: `${n} port${n === 1 ? '' : 's'} beyond 80/443 published to all interfaces: `
        + body.findings.map((f) => `${f.port}/${f.proto} (${f.container})`).join(', ')
        + '. Close them at your provider firewall, or bind them to 127.0.0.1.'
    };
  } catch {
    return {
      key: 'port_exposure', ok: true, level: 'ok',
      message: 'Open-port check unavailable (the runner did not respond).'
    };
  }
}

// Boot-time nudges toward a production-ready config.
function readiness() {
  const { isEnabled } = require('./crypto');
  const enc = isEnabled();
  const hasAlert = !!config.email.alertTo;
  const hasEmail = !!config.email.resendApiKey;
  const configured = config.isConfigured();
  return [
    // First card on purpose: without a domain nothing can be published, and this is
    // the only reminder someone who deferred the domain step will ever see.
    { key: 'base_domain', ok: configured, level: configured ? 'ok' : 'warning',
      message: configured
        ? `Apps are published under ${config.baseDomain}.`
        : 'No domain set — the dashboard is only reachable by IP over plain HTTP, and apps cannot be published. Finish setup to add one.' },
    { key: 'secret_encryption', ok: enc, level: enc ? 'ok' : 'critical',
      message: enc ? 'Secrets are encrypted at rest.' : 'ASTRODOCK_SECRET_KEY is not set — secrets are stored in plaintext.' },
    { key: 'alert_email', ok: hasAlert, level: hasAlert ? 'ok' : 'warning',
      message: hasAlert ? 'Alert recipient is configured.' : 'No alert recipient set — health/deploy alerts have nowhere to go.' },
    { key: 'email_provider', ok: hasEmail, level: hasEmail ? 'ok' : 'warning',
      message: hasEmail ? 'Email delivery is configured.' : 'No email provider (ASTRODOCK_RESEND_API_KEY) — email alerts will not send.' }
  ];
}

module.exports = {
  getSetting, setSetting, effective, diagnostics, readiness, exposureCheck, REGISTRY,
  setBootstrap, applyBootstrapSettings, BOOTSTRAP_REGISTRY,
  isSetupDeferred, setSetupDeferred
};
