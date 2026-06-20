-- Phase 6, Stage 10 — event/audit spine + platform settings store.
-- `events` is the unified record of everything noteworthy (health, deploy, pages,
-- auth, audit, system). It is both the audit trail and the source feed for
-- notification routing (added in a later migration). `platform_settings` holds
-- operator-editable overrides; infra/bootstrap config stays env-only.

CREATE TABLE IF NOT EXISTS events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  category    text NOT NULL,                       -- health|deploy|pages|auth|audit|system
  type        text NOT NULL,                       -- e.g. app.down, deploy.failed, settings.update
  severity    text NOT NULL DEFAULT 'info',        -- info|warning|critical
  actor_type  text NOT NULL DEFAULT 'system',      -- admin|token|user|system
  actor       text NOT NULL DEFAULT 'system',      -- admin email / token name / 'system'
  target_type text NOT NULL DEFAULT '',            -- app|user|token|page|setting
  target_id   text NOT NULL DEFAULT '',
  app_slug    text NOT NULL DEFAULT '',
  ip          text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);
CREATE INDEX IF NOT EXISTS events_category_idx   ON events (category);
CREATE INDEX IF NOT EXISTS events_app_slug_idx   ON events (app_slug);

CREATE TABLE IF NOT EXISTS platform_settings (
  key        text PRIMARY KEY,
  value      jsonb,                                -- scalar or object; interpreted per the settings registry
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
