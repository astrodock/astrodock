-- Phase 6, Stage 11 — notification routing.
-- `notification_rules`: operator-defined "when an event matches THIS, send it THERE".
-- `notification_deliveries`: append-only send log (also the dedup/rate-limit source).

CREATE TABLE IF NOT EXISTS notification_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  channel      text NOT NULL,                          -- email | webhook
  target       jsonb NOT NULL DEFAULT '{}'::jsonb,      -- email: {to}; webhook: {url, format}
  categories   jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [] = all categories
  min_severity text NOT NULL DEFAULT 'info',            -- info | warning | critical
  app_scope    jsonb NOT NULL DEFAULT '[]'::jsonb,      -- slug list; [] = all apps
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid,                                     -- the source event (no FK: log is independent/append-only)
  rule_id     uuid,
  channel     text NOT NULL,
  target      text NOT NULL DEFAULT '',                 -- resolved destination (address / url)
  status      text NOT NULL,                            -- sent | failed | suppressed | skipped
  error       text NOT NULL DEFAULT '',
  dedupe_key  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_deliveries_dedupe_idx     ON notification_deliveries (dedupe_key, created_at);
CREATE INDEX IF NOT EXISTS notif_deliveries_created_at_idx ON notification_deliveries (created_at);
