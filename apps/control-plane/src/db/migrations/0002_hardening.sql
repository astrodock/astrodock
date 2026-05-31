-- Hardening pass: deploy concurrency lock, persisted health, per-app token scope.

-- #6: at most one in-flight deployment per app (DB-enforced).
CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active_per_app
  ON deployments (app_slug)
  WHERE status IN ('pending', 'cloning', 'building', 'deploying');

-- #10: persist per-app health so alerting state survives a control-plane restart.
CREATE TABLE IF NOT EXISTS app_health (
  slug                 text PRIMARY KEY,
  status               text NOT NULL DEFAULT 'unknown',
  consecutive_failures integer NOT NULL DEFAULT 0,
  down_since           timestamptz,
  alert_sent           boolean NOT NULL DEFAULT false,
  last_check           timestamptz,
  response_time        integer,
  proc                 jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- #11: per-app token scoping. Empty array = unrestricted (all apps).
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS app_scope jsonb NOT NULL DEFAULT '[]'::jsonb;

-- #4 marker: secret columns may now hold "v1:..." encrypted blobs (no DDL change; text columns).
