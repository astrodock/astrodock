'use strict';

const { sql } = require('drizzle-orm');
const {
  pgTable, uuid, text, integer, bigint, boolean, jsonb, timestamp, uniqueIndex, index
} = require('drizzle-orm/pg-core');

// ── users ──────────────────────────────────────────────────────────────────
const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull(),
  name: text('name').notNull(),
  // Nullable: an account may authenticate by passkey alone. The
  // always-one-primary-factor invariant is enforced in lib/auth-factors.
  passwordHash: text('password_hash'),
  isActive: boolean('is_active').notNull().default(true),
  isAdmin: boolean('is_admin').notNull().default(false), // legacy; operatorRole is authoritative
  // null = not an operator (a pure end user). owner | admin | operator | viewer.
  operatorRole: text('operator_role'),
  totpSecret: text('totp_secret'),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  passwordless: boolean('passwordless').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  appAccess: jsonb('app_access').notNull().default(sql`'[]'::jsonb`), // string[] of app slugs
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  emailUniq: uniqueIndex('users_email_uniq').on(t.email)
}));

// ── apps ───────────────────────────────────────────────────────────────────
const apps = pgTable('apps', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // Appearance of the hosted sign-in page. Not a security boundary — the page is
  // still served by the platform, on the platform's origin.
  brandColor: text('brand_color').notNull().default(''),
  logoUrl: text('logo_url').notNull().default(''),
  subdomain: text('subdomain').notNull(),
  port: integer('port').notNull(),

  // runtime
  runtimeType: text('runtime_type').notNull().default('node'), // node | docker
  buildCommand: text('build_command').notNull().default('npm run build'),
  dockerfile: text('dockerfile').notNull().default('Dockerfile'),

  // source
  branch: text('branch').notNull().default('main'),
  repoPath: text('repo_path').notNull().default(''),
  githubRepo: text('github_repo').notNull().default(''),
  webhookId: bigint('webhook_id', { mode: 'number' }),
  webhookSecret: text('webhook_secret').notNull().default(''),

  // resource modes
  authMode: text('auth_mode').notNull().default('platform'),       // platform | public
  databaseMode: text('database_mode').notNull().default('none'),   // internal | external | none
  storageMode: text('storage_mode').notNull().default('none'),     // internal | external | none

  // platform-generated secrets (never operator-edited)
  appSecret: text('app_secret').notNull(),
  appJwtSecret: text('app_jwt_secret').notNull(),

  // internal-DB provisioning state
  dbName: text('db_name'),
  dbUser: text('db_user'),
  dbPassword: text('db_password'),

  // internal-storage provisioning state. With scoped per-app keys: own bucket +
  // dedicated key. Without (fallback): shared bucket + prefix, keys stay null.
  storagePrefix: text('storage_prefix'),
  storageBucket: text('storage_bucket'),
  storageAccessKey: text('storage_access_key'),
  storageSecretKey: text('storage_secret_key'),

  provisioned: boolean('provisioned').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  slugUniq: uniqueIndex('apps_slug_uniq').on(t.slug),
  subdomainUniq: uniqueIndex('apps_subdomain_uniq').on(t.subdomain)
}));

// ── app_env_vars ─────────────────────────────────────────────────────────────
// Holds both app-declared vars (from app.json env[]) and external-mode reserved
// vars that need an operator value (ASTRODOCK_DATABASE_URL / ASTRODOCK_STORAGE_*).
const appEnvVars = pgTable('app_env_vars', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value'),                                   // null = unset
  isSecret: boolean('is_secret').notNull().default(false),
  isRequired: boolean('is_required').notNull().default(false),
  defaultValue: text('default_value'),
  description: text('description').notNull().default(''),
  kind: text('kind').notNull().default('declared'),       // declared | reserved
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  appKeyUniq: uniqueIndex('app_env_vars_app_key_uniq').on(t.appId, t.key)
}));

// ── deployments ──────────────────────────────────────────────────────────────
const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  appSlug: text('app_slug').notNull(),
  status: text('status').notNull().default('pending'), // pending|cloning|building|deploying|success|failed
  trigger: text('trigger').notNull().default('manual'), // webhook|manual|cli
  commitHash: text('commit_hash').notNull().default(''),
  commitMessage: text('commit_message').notNull().default(''),
  log: text('log').notNull().default(''),
  error: text('error').notNull().default(''),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  appSlugIdx: index('deployments_app_slug_idx').on(t.appSlug),
  createdAtIdx: index('deployments_created_at_idx').on(t.createdAt)
}));

// ── auth_logs ────────────────────────────────────────────────────────────────
const authLogs = pgTable('auth_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull(),
  appId: text('app_id').notNull(),
  result: text('result').notNull(),
  ip: text('ip').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  createdAtIdx: index('auth_logs_created_at_idx').on(t.createdAt)
}));

// ── api_tokens ───────────────────────────────────────────────────────────────
const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),
  appScope: jsonb('app_scope').notNull().default(sql`'[]'::jsonb`), // slug list; [] = all apps
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // The human at the root of the delegation chain — inherited by keys a key mints,
  // so every action can name who authorised it.
  authorizedByUserId: uuid('authorized_by_user_id'),
  createdByTokenId: uuid('created_by_token_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  tokenHashUniq: uniqueIndex('api_tokens_hash_uniq').on(t.tokenHash)
}));

// ── auth factors ───────────────────────────────────────────────────────────
const webauthnCredentials = pgTable('webauthn_credentials', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').notNull(),
  credentialId: text('credential_id').notNull(),
  publicKey: text('public_key').notNull(),
  signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').notNull().default(sql`'[]'::jsonb`),
  label: text('label').notNull().default(''),
  // Recorded because WebAuthn credentials are bound to the RP ID that created
  // them: changing the base domain invalidates them, and we want to say which.
  rpId: text('rp_id').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true })
}, (t) => ({
  credIdUniq: uniqueIndex('webauthn_credential_id_uniq').on(t.credentialId),
  userIdx: index('webauthn_user_idx').on(t.userId)
}));

const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({ userIdx: index('recovery_codes_user_idx').on(t.userId) }));

const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').notNull(),
  userAgent: text('user_agent').notNull().default(''),
  ip: text('ip').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Independent of session age: step-up actions require a RECENT factor check.
  reauthAt: timestamp('reauth_at', { withTimezone: true })
}, (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }));

// ── hosted login ───────────────────────────────────────────────────────────
const authorizationCodes = pgTable('authorization_codes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  codeHash: text('code_hash').notNull(),
  appId: uuid('app_id').notNull(),
  userId: uuid('user_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({ codeUniq: uniqueIndex('authorization_codes_hash_uniq').on(t.codeHash) }));

const appRedirectUris = pgTable('app_redirect_uris', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  appId: uuid('app_id').notNull(),
  uri: text('uri').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({ uniq: uniqueIndex('app_redirect_uris_uniq').on(t.appId, t.uri) }));

// Persisted per-app health (so alerting state survives a control-plane restart).
const appHealth = pgTable('app_health', {
  slug: text('slug').primaryKey(),
  status: text('status').notNull().default('unknown'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  downSince: timestamp('down_since', { withTimezone: true }),
  alertSent: boolean('alert_sent').notNull().default(false),
  lastCheck: timestamp('last_check', { withTimezone: true }),
  responseTime: integer('response_time'),
  proc: jsonb('proc'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ── pages (lightweight hosted documents / mini-sites) ──────────────────────────
const pages = pgTable('pages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pageId: text('page_id').notNull(),          // 12-char public handle in the URL
  title: text('title').notNull().default(''),
  entryFile: text('entry_file').notNull().default('index.html'),
  accessMode: text('access_mode').notNull().default('public'), // public | passkey | platform
  passkey: text('passkey'),                   // encrypted at rest; null unless passkey mode
  allowlist: jsonb('allowlist').notNull().default(sql`'[]'::jsonb`), // emails; [] = any active user (platform mode)
  dataMode: text('data_mode').notNull().default('none'),       // none | shared | per-user
  isActive: boolean('is_active').notNull().default(true),
  views: integer('views').notNull().default(0),
  lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  pageIdUniq: uniqueIndex('pages_page_id_uniq').on(t.pageId)
}));

const pageFiles = pgTable('page_files', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),               // relative path, e.g. "index.html" or "img/logo.png"
  size: integer('size').notNull().default(0),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  storageKey: text('storage_key').notNull(),  // object-store key
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  pageNameUniq: uniqueIndex('page_files_page_name_uniq').on(t.pageId, t.name)
}));

// ── events ─────────────────────────────────────────────────────────────────
// Unified audit + system-event log; also the source feed for notifications.
const events = pgTable('events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  category: text('category').notNull(),                  // health|deploy|pages|auth|audit|system
  type: text('type').notNull(),                          // e.g. app.down, deploy.failed, settings.update
  severity: text('severity').notNull().default('info'),  // info|warning|critical
  actorType: text('actor_type').notNull().default('system'), // admin|token|user|system
  actor: text('actor').notNull().default('system'),      // admin email / token name / 'system'
  targetType: text('target_type').notNull().default(''), // app|user|token|page|setting
  targetId: text('target_id').notNull().default(''),
  appSlug: text('app_slug').notNull().default(''),
  ip: text('ip').notNull().default(''),
  message: text('message').notNull().default(''),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`)
}, (t) => ({
  createdAtIdx: index('events_created_at_idx').on(t.createdAt),
  categoryIdx: index('events_category_idx').on(t.category),
  appSlugIdx: index('events_app_slug_idx').on(t.appSlug)
}));

// ── platform_settings ────────────────────────────────────────────────────────
// Operator-editable operational overrides (env/config supplies the defaults).
const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),                                 // scalar or object; interpreted per the settings registry
  updatedBy: text('updated_by').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ── notification_rules ───────────────────────────────────────────────────────
// "When an event matches THIS, send it THERE." Empty categories/appScope = all.
const notificationRules = pgTable('notification_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  channel: text('channel').notNull(),                    // email | webhook
  target: jsonb('target').notNull().default(sql`'{}'::jsonb`), // email: {to}; webhook: {url, format}
  categories: jsonb('categories').notNull().default(sql`'[]'::jsonb`),
  minSeverity: text('min_severity').notNull().default('info'),
  appScope: jsonb('app_scope').notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ── notification_deliveries ──────────────────────────────────────────────────
// Append-only send log; also the dedup/rate-limit source.
const notificationDeliveries = pgTable('notification_deliveries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventId: uuid('event_id'),
  ruleId: uuid('rule_id'),
  channel: text('channel').notNull(),
  target: text('target').notNull().default(''),
  status: text('status').notNull(),                      // sent | failed | suppressed | skipped
  error: text('error').notNull().default(''),
  dedupeKey: text('dedupe_key').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  dedupeIdx: index('notif_deliveries_dedupe_idx').on(t.dedupeKey, t.createdAt),
  createdAtIdx: index('notif_deliveries_created_at_idx').on(t.createdAt)
}));

// One small JSON blob per page (shared) or per page+user (per-user). Size-capped.
const pageData = pgTable('page_data', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),                    // null = shared blob; else the platform user
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
// Uniqueness (one shared blob per page; one per-user blob per page+user) is enforced
// by partial indexes in the 0004_pages migration — NULL user_id needs special handling.

// ── page_views ───────────────────────────────────────────────────────────────
// Per-request access log for Pages (the aggregate `pages.views` counter stays for
// cheap display). IP storage honors the logging.page_view_ip setting.
const pageViews = pgTable('page_views', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  path: text('path').notNull().default(''),
  ip: text('ip').notNull().default(''),
  userAgent: text('user_agent').notNull().default(''),
  referrer: text('referrer').notNull().default(''),
  userId: uuid('user_id'),
  status: integer('status').notNull().default(200),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  pageIdx: index('page_views_page_idx').on(t.pageId, t.createdAt),
  createdAtIdx: index('page_views_created_at_idx').on(t.createdAt)
}));

// ── backups ──────────────────────────────────────────────────────────────────
const backups = pgTable('backups', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  kind: text('kind').notNull().default('postgres'),
  status: text('status').notNull(),                      // success | failed
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  path: text('path').notNull().default(''),
  trigger: text('trigger').notNull().default('scheduled'), // scheduled | manual
  error: text('error').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  createdAtIdx: index('backups_created_at_idx').on(t.createdAt)
}));

// ── custom_domains ───────────────────────────────────────────────────────────
// Operator-owned external hostnames pointed at an app (in addition to its
// <subdomain>.<base-domain>). Verified by a TXT challenge; served via Caddy
// on-demand TLS once active.
const customDomains = pgTable('custom_domains', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  status: text('status').notNull().default('pending'),   // pending | active | failed
  verificationToken: text('verification_token').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  redirectToCanonical: boolean('redirect_to_canonical').notNull().default(false),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  hostnameUniq: uniqueIndex('custom_domains_hostname_uniq').on(t.hostname),
  appIdx: index('custom_domains_app_idx').on(t.appId)
}));

module.exports = { users, webauthnCredentials, recoveryCodes, sessions, authorizationCodes, appRedirectUris, apps, appEnvVars, deployments, authLogs, apiTokens, appHealth, pages, pageFiles, pageData, events, platformSettings, notificationRules, notificationDeliveries, pageViews, backups, customDomains };
