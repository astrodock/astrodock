-- Pages: lightweight hosted documents / mini-sites served at pages.<base-domain>/{pageId}/.

CREATE TABLE IF NOT EXISTS pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        text NOT NULL,
  title          text NOT NULL DEFAULT '',
  entry_file     text NOT NULL DEFAULT 'index.html',
  access_mode    text NOT NULL DEFAULT 'public',   -- public | passkey | platform
  passkey        text,                              -- encrypted at rest; null unless passkey mode
  allowlist      jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_mode      text NOT NULL DEFAULT 'none',      -- none | shared | per-user
  is_active      boolean NOT NULL DEFAULT true,
  views          integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_page_id_uniq ON pages (page_id);

CREATE TABLE IF NOT EXISTS page_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name         text NOT NULL,
  size         integer NOT NULL DEFAULT 0,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS page_files_page_name_uniq ON page_files (page_id, name);

CREATE TABLE IF NOT EXISTS page_data (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id    uuid,                              -- null = shared blob; else the platform user
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one shared blob per page (user_id IS NULL) ...
CREATE UNIQUE INDEX IF NOT EXISTS page_data_shared_uniq ON page_data (page_id) WHERE user_id IS NULL;
-- ... and one blob per (page, user) for per-user mode
CREATE UNIQUE INDEX IF NOT EXISTS page_data_user_uniq ON page_data (page_id, user_id) WHERE user_id IS NOT NULL;
