-- Phase 6, Stage 16 — custom domains for apps (verified + on-demand TLS).

CREATE TABLE IF NOT EXISTS custom_domains (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  hostname              text NOT NULL,
  status                text NOT NULL DEFAULT 'pending',  -- pending | active | failed
  verification_token    text NOT NULL,
  is_primary            boolean NOT NULL DEFAULT false,
  redirect_to_canonical boolean NOT NULL DEFAULT false,
  last_checked_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_hostname_uniq ON custom_domains (hostname);
CREATE INDEX IF NOT EXISTS custom_domains_app_idx ON custom_domains (app_id);
