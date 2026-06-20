-- Phase 6, Stage 14 — backup run history.

CREATE TABLE IF NOT EXISTS backups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL DEFAULT 'postgres',
  status     text NOT NULL,                      -- success | failed
  size_bytes bigint,
  path       text NOT NULL DEFAULT '',
  trigger    text NOT NULL DEFAULT 'scheduled',  -- scheduled | manual
  error      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_created_at_idx ON backups (created_at);
