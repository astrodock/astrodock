'use strict';

// Central configuration for the control plane. Everything is read from the
// environment with the reserved TOOLSTEAD_ prefix. No org-specific defaults —
// the only baked-in fallbacks are safe local-dev values.

require('dotenv').config();

function bool(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const PG_HOST = process.env.TOOLSTEAD_PG_HOST || 'localhost';
const PG_PORT = int(process.env.TOOLSTEAD_PG_PORT, 5432);
const PG_USER = process.env.TOOLSTEAD_PG_USER || 'toolstead';
const PG_PASSWORD = process.env.TOOLSTEAD_PG_PASSWORD || 'toolstead';
const PG_DATABASE = process.env.TOOLSTEAD_PG_DATABASE || 'toolstead';

function pgUrl(database) {
  const u = encodeURIComponent(PG_USER);
  const p = encodeURIComponent(PG_PASSWORD);
  return `postgresql://${u}:${p}@${PG_HOST}:${PG_PORT}/${database}`;
}

const config = {
  // ── HTTP ──
  port: int(process.env.PORT, 3100),
  env: process.env.TOOLSTEAD_ENV || process.env.NODE_ENV || 'production',

  // ── Domain / routing ──
  baseDomain: process.env.TOOLSTEAD_BASE_DOMAIN || 'localhost',
  adminSubdomain: process.env.TOOLSTEAD_ADMIN_SUBDOMAIN || 'admin',
  tlsMode: (process.env.TOOLSTEAD_TLS_MODE || 'internal').toLowerCase(), // auto | internal | off
  acmeEmail: process.env.TOOLSTEAD_ACME_EMAIL || '',
  // Override the CORS allowed-origin regex; otherwise derived from baseDomain.
  allowedOriginPattern: process.env.TOOLSTEAD_ALLOWED_ORIGIN_PATTERN || '',

  // ── Admin auth ──
  adminJwtSecret: process.env.TOOLSTEAD_ADMIN_JWT_SECRET || '',
  // Master key for encrypting stored secrets at rest (AES-256-GCM). If unset,
  // secrets are stored in plaintext (back-compat) and a warning is logged at boot.
  secretKey: process.env.TOOLSTEAD_SECRET_KEY || '',
  adminEmail: process.env.TOOLSTEAD_ADMIN_EMAIL || '',
  adminPassword: process.env.TOOLSTEAD_ADMIN_PASSWORD || '',

  // ── Bundled Postgres (control-plane store + internal app DBs) ──
  pg: {
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
    url: pgUrl(PG_DATABASE),
    // host:port apps use to reach the bundled DB (on the compose network this is "postgres")
    appHost: process.env.TOOLSTEAD_PG_APP_HOST || PG_HOST,
    appPort: int(process.env.TOOLSTEAD_PG_APP_PORT, PG_PORT)
  },
  pgUrl,

  // ── Bundled object store (SeaweedFS S3) ──
  objectstore: {
    endpoint: process.env.TOOLSTEAD_OBJECTSTORE_ENDPOINT || 'http://localhost:8333',
    // endpoint apps should use (compose-network address); falls back to endpoint
    appEndpoint: process.env.TOOLSTEAD_OBJECTSTORE_APP_ENDPOINT || process.env.TOOLSTEAD_OBJECTSTORE_ENDPOINT || 'http://objectstore:8333',
    region: process.env.TOOLSTEAD_OBJECTSTORE_REGION || 'us-east-1',
    accessKey: process.env.TOOLSTEAD_OBJECTSTORE_ACCESS_KEY || '',
    secretKey: process.env.TOOLSTEAD_OBJECTSTORE_SECRET_KEY || '',
    bucket: process.env.TOOLSTEAD_OBJECTSTORE_BUCKET || 'toolstead'
  },

  // ── GitHub ──
  github: {
    pat: process.env.TOOLSTEAD_GITHUB_PAT || '',
    owner: process.env.TOOLSTEAD_GITHUB_OWNER || ''
  },

  // ── Runner / filesystem (paths inside the runner container) ──
  paths: {
    static: process.env.TOOLSTEAD_STATIC_DIR || '/data/static',
    apps: process.env.TOOLSTEAD_APPS_DIR || '/data/apps',
    repos: process.env.TOOLSTEAD_REPOS_DIR || '/data/repos',
    // the SAME static volume as seen from inside the Caddy container
    caddyStatic: process.env.TOOLSTEAD_CADDY_STATIC_DIR || '/srv/static'
  },

  // ── Caddy ──
  caddyAdmin: process.env.TOOLSTEAD_CADDY_ADMIN || 'http://localhost:2019',

  // ── Docker (sibling containers for Dockerfile apps) ──
  dockerNetwork: process.env.TOOLSTEAD_DOCKER_NETWORK || 'toolstead_default',

  // ── Email / alerts ──
  email: {
    from: process.env.TOOLSTEAD_EMAIL_FROM || 'Toolstead <noreply@example.com>',
    alertTo: process.env.TOOLSTEAD_ALERT_EMAIL || '',
    resendApiKey: process.env.TOOLSTEAD_RESEND_API_KEY || ''
  },

  // ── Feature flags ──
  enableTerminal: bool(process.env.TOOLSTEAD_ENABLE_TERMINAL, false),

  // base port for app processes (control plane is on `port`)
  basePort: int(process.env.TOOLSTEAD_BASE_PORT, 3101)
};

// The internal /verify address apps use (compose-network address of this service).
config.internalAuthUrl = process.env.TOOLSTEAD_INTERNAL_AUTH_URL || `http://api:${config.port}`;

// CORS allowed-origin matcher, config-driven (no hardcoded org domain).
config.isAllowedOrigin = function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server / curl
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  if (config.allowedOriginPattern) {
    try { return new RegExp(config.allowedOriginPattern).test(origin); } catch { /* fall through */ }
  }
  const d = config.baseDomain.replace(/\./g, '\\.');
  return new RegExp(`^https?://(.*\\.)?${d}$`).test(origin);
};

module.exports = config;
