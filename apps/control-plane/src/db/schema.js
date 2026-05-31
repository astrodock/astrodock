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
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  isAdmin: boolean('is_admin').notNull().default(false),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  tokenHashUniq: uniqueIndex('api_tokens_hash_uniq').on(t.tokenHash)
}));

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

module.exports = { users, apps, appEnvVars, deployments, authLogs, apiTokens, appHealth };
