'use strict';

// Central configuration for the control plane. Everything is read from the
// environment with the reserved ASTRODOCK_ prefix. No org-specific defaults —
// the only baked-in fallbacks are safe local-dev values.

// Load the repo-root .env regardless of cwd. npm workspaces run package scripts
// with cwd set to the package directory, so a bare dotenv.config() would look for
// apps/control-plane/.env and silently find nothing — leaving the process on
// built-in defaults. Under Docker, compose's env_file has already populated the
// environment (dotenv never overrides what is set) and this path doesn't exist.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

function bool(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function parseSize(v, def) {
  if (v == null || v === '') return def;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return def;
  const mult = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

const PG_HOST = process.env.ASTRODOCK_PG_HOST || 'localhost';
const PG_PORT = int(process.env.ASTRODOCK_PG_PORT, 5432);
const PG_USER = process.env.ASTRODOCK_PG_USER || 'astrodock';
const PG_PASSWORD = process.env.ASTRODOCK_PG_PASSWORD || 'astrodock';
const PG_DATABASE = process.env.ASTRODOCK_PG_DATABASE || 'astrodock';

function pgUrl(database) {
  const u = encodeURIComponent(PG_USER);
  const p = encodeURIComponent(PG_PASSWORD);
  return `postgresql://${u}:${p}@${PG_HOST}:${PG_PORT}/${database}`;
}

const config = {
  // ── HTTP ──
  port: int(process.env.PORT, 3100),
  env: process.env.ASTRODOCK_ENV || process.env.NODE_ENV || 'production',

  // ── Domain / routing ──
  // Empty = UNCONFIGURED. The stack is designed to boot with no domain at all and
  // serve the first-run wizard over the server's IP (see provision/caddy.js
  // setupBlock), so `docker compose up -d` is the only command an operator runs.
  // The wizard sets this at runtime via applyRuntimeDomain().
  baseDomain: process.env.ASTRODOCK_BASE_DOMAIN || '',
  adminSubdomain: process.env.ASTRODOCK_ADMIN_SUBDOMAIN || 'admin',
  // The hosted sign-in lives on its own host. It used to be served from the admin
  // host, so an app's users were sent to a hostname called "admin" to sign in —
  // confusing for them, and it advertised where the dashboard lives to everyone
  // who ever signed into anything.
  authSubdomain: process.env.ASTRODOCK_AUTH_SUBDOMAIN || 'auth',
  tlsMode: (process.env.ASTRODOCK_TLS_MODE || 'internal').toLowerCase(), // auto | internal | off
  acmeEmail: process.env.ASTRODOCK_ACME_EMAIL || '',
  // Override the CORS allowed-origin regex; otherwise derived from baseDomain.
  allowedOriginPattern: process.env.ASTRODOCK_ALLOWED_ORIGIN_PATTERN || '',
  // Public IP of this server, shown in custom-domain DNS instructions (the A record target).
  publicIp: process.env.ASTRODOCK_PUBLIC_IP || '',

  // ── Admin auth ──
  adminJwtSecret: process.env.ASTRODOCK_ADMIN_JWT_SECRET || '',
  // Master key for encrypting stored secrets at rest (AES-256-GCM). If unset,
  // secrets are stored in plaintext (back-compat) and a warning is logged at boot.
  secretKey: process.env.ASTRODOCK_SECRET_KEY || '',
  adminEmail: process.env.ASTRODOCK_ADMIN_EMAIL || '',
  adminPassword: process.env.ASTRODOCK_ADMIN_PASSWORD || '',
  // Operator-chosen first-run setup token. Set this at install time (e.g. a cloud
  // provider's user-data field) and you never have to read the container logs to
  // claim the admin account — which is what makes a terminal-free install possible.
  // Unset = one is generated and printed at boot, as before.
  setupToken: process.env.ASTRODOCK_SETUP_TOKEN || '',

  // ── Bundled Postgres (control-plane store + internal app DBs) ──
  pg: {
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
    url: pgUrl(PG_DATABASE),
    // host:port apps use to reach the bundled DB (on the compose network this is "postgres")
    appHost: process.env.ASTRODOCK_PG_APP_HOST || PG_HOST,
    appPort: int(process.env.ASTRODOCK_PG_APP_PORT, PG_PORT)
  },
  pgUrl,

  // ── Bundled object store (SeaweedFS S3) ──
  objectstore: {
    endpoint: process.env.ASTRODOCK_OBJECTSTORE_ENDPOINT || 'http://localhost:8333',
    // endpoint apps should use (compose-network address); falls back to endpoint
    appEndpoint: process.env.ASTRODOCK_OBJECTSTORE_APP_ENDPOINT || process.env.ASTRODOCK_OBJECTSTORE_ENDPOINT || 'http://objectstore:8333',
    region: process.env.ASTRODOCK_OBJECTSTORE_REGION || 'us-east-1',
    accessKey: process.env.ASTRODOCK_OBJECTSTORE_ACCESS_KEY || '',
    secretKey: process.env.ASTRODOCK_OBJECTSTORE_SECRET_KEY || '',
    bucket: process.env.ASTRODOCK_OBJECTSTORE_BUCKET || 'astrodock'
  },

  // ── GitHub ──
  github: {
    pat: process.env.ASTRODOCK_GITHUB_PAT || '',
    owner: process.env.ASTRODOCK_GITHUB_OWNER || ''
  },

  // ── Runner / filesystem (paths inside the runner container) ──
  paths: {
    static: process.env.ASTRODOCK_STATIC_DIR || '/data/static',
    apps: process.env.ASTRODOCK_APPS_DIR || '/data/apps',
    repos: process.env.ASTRODOCK_REPOS_DIR || '/data/repos',
    // the SAME static volume as seen from inside the Caddy container
    caddyStatic: process.env.ASTRODOCK_CADDY_STATIC_DIR || '/srv/static',
    // Caddy per-app access logs (shared volume); the control plane reads these back
    accessLogs: process.env.ASTRODOCK_ACCESS_LOG_DIR || '/var/log/caddy'
  },

  // ── Caddy ──
  caddyAdmin: process.env.ASTRODOCK_CADDY_ADMIN || 'http://localhost:2019',

  // ── Docker (sibling containers for Dockerfile apps) ──
  dockerNetwork: process.env.ASTRODOCK_DOCKER_NETWORK || 'astrodock_default',

  // ── Email / alerts ──
  email: {
    from: process.env.ASTRODOCK_EMAIL_FROM || 'Astrodock <noreply@example.com>',
    alertTo: process.env.ASTRODOCK_ALERT_EMAIL || '',
    resendApiKey: process.env.ASTRODOCK_RESEND_API_KEY || ''
  },

  // ── Pages (lightweight hosted documents / mini-sites at pages.<base-domain>) ──
  pages: {
    subdomain: process.env.ASTRODOCK_PAGES_SUBDOMAIN || 'pages',
    bucket: process.env.ASTRODOCK_PAGES_BUCKET || 'astrodock-pages',
    dataMax: process.env.ASTRODOCK_PAGE_DATA_MAX || '1mb',
    dataMaxBytes: parseSize(process.env.ASTRODOCK_PAGE_DATA_MAX, 1024 * 1024),
    maxFilesPerUpload: int(process.env.ASTRODOCK_PAGE_MAX_FILES, 20),
    maxFileBytes: parseSize(process.env.ASTRODOCK_PAGE_MAX_FILE, 200 * 1024 * 1024),
    editTextMaxBytes: parseSize(process.env.ASTRODOCK_PAGE_EDIT_MAX, 2 * 1024 * 1024)
  },

  // ── Backups (run on the runner; needs the Docker socket + a backups volume) ──
  backups: {
    dir: process.env.ASTRODOCK_BACKUP_DIR || '/data/backups',
    intervalHours: int(process.env.ASTRODOCK_BACKUP_INTERVAL_HOURS, 24), // 0 = disabled
    keep: int(process.env.ASTRODOCK_BACKUP_KEEP, 7),
    pgContainer: process.env.ASTRODOCK_PG_CONTAINER || 'astrodock-postgres-1',
    // Restarted by the runner after a restore, so the api reconnects to the
    // replaced database instead of serving what it had cached.
    apiContainer: process.env.ASTRODOCK_API_CONTAINER || 'astrodock-api-1'
  },

  // Deploy build timeouts (per command). A hung build fails instead of wedging the runner.
  deploy: {
    buildTimeoutMs: int(process.env.ASTRODOCK_BUILD_TIMEOUT_MS, 300000),
    dockerBuildTimeoutMs: int(process.env.ASTRODOCK_DOCKER_BUILD_TIMEOUT_MS, 600000)
  },

  // base port for app processes (control plane is on `port`)
  basePort: int(process.env.ASTRODOCK_BASE_PORT, 3101),

  // ── runner (separate container; holds the Docker socket + PAT + PM2) ──
  role: process.env.ASTRODOCK_ROLE || 'control-plane', // 'control-plane' | 'runner'
  runnerPort: int(process.env.ASTRODOCK_RUNNER_PORT, 3200),
  runnerUrl: process.env.ASTRODOCK_RUNNER_URL || 'http://runner:3200',
  runnerToken: process.env.ASTRODOCK_RUNNER_TOKEN || ''
};

// The internal /verify address apps use (compose-network address of this service).
config.internalAuthUrl = process.env.ASTRODOCK_INTERNAL_AUTH_URL || `http://api:${config.port}`;

// ── Setup state + runtime domain ──────────────────────────────────────────────
// The base domain is the ONE bootstrap value a human must supply, and the wizard
// collects it after boot. Every consumer reads config.baseDomain at call time, so
// the only thing that has to be refreshed when it changes is the derived Pages
// host below. (BUILD_PLAN.md re-pins this: domain/TLS are runtime-settable; the
// rest of the bootstrap tier — PG creds, secret key, runner token — stays env-only.)
function recomputeDerived() {
  config.pages.host = `${config.pages.subdomain}.${config.baseDomain}`;
  config.authHost = `${config.authSubdomain}.${config.baseDomain}`;
}

config.isConfigured = function isConfigured() {
  return !!config.baseDomain;
};

// Apply a domain/TLS change in place. Callers are responsible for persisting it
// (lib/settings setBootstrap) and for regenerating routing afterwards.
config.applyRuntimeDomain = function applyRuntimeDomain({ baseDomain, tlsMode, acmeEmail } = {}) {
  if (baseDomain != null) config.baseDomain = String(baseDomain).trim().toLowerCase();
  if (tlsMode != null) config.tlsMode = String(tlsMode).trim().toLowerCase();
  if (acmeEmail != null) config.acmeEmail = String(acmeEmail).trim();
  recomputeDerived();
  return { baseDomain: config.baseDomain, tlsMode: config.tlsMode, acmeEmail: config.acmeEmail };
};

// The host Pages are served on, e.g. pages.example.com.
recomputeDerived();
// The host the hosted sign-in is served on, e.g. auth.example.com.
config.isAuthHost = function isAuthHost(hostname) {
  if (!config.isConfigured()) return false;
  return (hostname || '').toLowerCase() === String(config.authHost || '').toLowerCase();
};

// Where an app should send its users. Falls back to the admin host before setup,
// which is the only host that exists then.
config.authBaseUrl = function authBaseUrl() {
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  if (!config.isConfigured()) return '';
  return `${scheme}://${config.authHost}`;
};

config.isPagesHost = function isPagesHost(hostname) {
  // Before setup there is no Pages host; an empty base domain would make this
  // match "pages." and hijack every request.
  if (!config.isConfigured()) return false;
  return (hostname || '').toLowerCase() === config.pages.host.toLowerCase();
};

// CORS allowed-origin matcher, config-driven (no hardcoded org domain).
config.isAllowedOrigin = function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server / curl
  // localhost is allowed only outside production (the Vite dev server) — not in prod
  if (config.env !== 'production') {
    if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
    if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  }
  if (config.allowedOriginPattern) {
    try { return new RegExp(config.allowedOriginPattern).test(origin); } catch { /* fall through */ }
  }
  // Before setup the wizard is reached at http://<server-ip>, which we cannot know
  // in advance, and a same-origin POST still carries an Origin header — so a strict
  // matcher would block the very flow that sets the domain. Nothing here is
  // protected by CORS anyway: /setup/claim is guarded by the setup token, and CORS
  // never applied to non-browser callers. Once a domain is set this closes.
  if (!config.isConfigured()) return true;
  const d = config.baseDomain.replace(/\./g, '\\.');
  return new RegExp(`^https?://(.*\\.)?${d}$`).test(origin);
};

module.exports = config;
