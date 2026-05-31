-- Astrodock control-plane initial schema.
-- Applied by src/db/migrate.js (which tracks applied files in schema_migrations).

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  is_admin      boolean NOT NULL DEFAULT false,
  app_access    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (lower(email));

CREATE TABLE IF NOT EXISTS apps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  subdomain      text NOT NULL,
  port           integer NOT NULL,
  runtime_type   text NOT NULL DEFAULT 'node',
  build_command  text NOT NULL DEFAULT 'npm run build',
  dockerfile     text NOT NULL DEFAULT 'Dockerfile',
  branch         text NOT NULL DEFAULT 'main',
  repo_path      text NOT NULL DEFAULT '',
  github_repo    text NOT NULL DEFAULT '',
  webhook_id     bigint,
  webhook_secret text NOT NULL DEFAULT '',
  auth_mode      text NOT NULL DEFAULT 'platform',
  database_mode  text NOT NULL DEFAULT 'none',
  storage_mode   text NOT NULL DEFAULT 'none',
  app_secret     text NOT NULL,
  app_jwt_secret text NOT NULL,
  db_name        text,
  db_user        text,
  db_password    text,
  storage_prefix text,
  provisioned    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_slug_uniq ON apps (slug);
CREATE UNIQUE INDEX IF NOT EXISTS apps_subdomain_uniq ON apps (subdomain);

CREATE TABLE IF NOT EXISTS app_env_vars (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key           text NOT NULL,
  value         text,
  is_secret     boolean NOT NULL DEFAULT false,
  is_required   boolean NOT NULL DEFAULT false,
  default_value text,
  description   text NOT NULL DEFAULT '',
  kind          text NOT NULL DEFAULT 'declared',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_env_vars_app_key_uniq ON app_env_vars (app_id, key);

CREATE TABLE IF NOT EXISTS deployments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_slug       text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  trigger        text NOT NULL DEFAULT 'manual',
  commit_hash    text NOT NULL DEFAULT '',
  commit_message text NOT NULL DEFAULT '',
  log            text NOT NULL DEFAULT '',
  error          text NOT NULL DEFAULT '',
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deployments_app_slug_idx ON deployments (app_slug);
CREATE INDEX IF NOT EXISTS deployments_created_at_idx ON deployments (created_at);

CREATE TABLE IF NOT EXISTS auth_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  app_id     text NOT NULL,
  result     text NOT NULL,
  ip         text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_logs_created_at_idx ON auth_logs (created_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  token_hash   text NOT NULL,
  scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_uniq ON api_tokens (token_hash);
