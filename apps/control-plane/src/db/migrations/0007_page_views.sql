-- Phase 6, Stage 13 — per-request page access log.
-- The aggregate pages.views counter stays for cheap display; this gives source/
-- referrer/path detail over time. IP storage honors the logging.page_view_ip setting.

CREATE TABLE IF NOT EXISTS page_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  path       text NOT NULL DEFAULT '',
  ip         text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  referrer   text NOT NULL DEFAULT '',
  user_id    uuid,
  status     integer NOT NULL DEFAULT 200,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_views_page_idx       ON page_views (page_id, created_at);
CREATE INDEX IF NOT EXISTS page_views_created_at_idx ON page_views (created_at);
