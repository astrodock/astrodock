-- Artifact logging: who opened what, what they read and changed, sign-in
-- attempts, errors in the pages, record history, and problem reports.
-- Pruned after logging.artifact_log_retention_days (default 90), except reports.

-- One row per page (HTML) served, and per sign-in redirect.
CREATE TABLE IF NOT EXISTS artifact_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id uuid,
  email text NOT NULL DEFAULT '',
  path text NOT NULL DEFAULT '',
  status integer NOT NULL DEFAULT 200,
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  referrer text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_views_artifact_idx ON artifact_views (artifact_id, created_at);

-- Every write and every failed call to the data API, in full.
CREATE TABLE IF NOT EXISTS artifact_api_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id uuid,
  email text NOT NULL DEFAULT '',
  method text NOT NULL,
  op text NOT NULL,              -- list | get | create | update | delete | count | stream | blob.get | blob.set | me | log
  target text NOT NULL DEFAULT '',
  record_id text NOT NULL DEFAULT '',
  status integer NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_api_log_artifact_idx ON artifact_api_log (artifact_id, created_at);

-- Successful reads, counted per artifact, person, target and hour.
CREATE TABLE IF NOT EXISTS artifact_read_counts (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  user_key text NOT NULL DEFAULT '',   -- user id, or '' for an anonymous visitor
  target text NOT NULL DEFAULT '',
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, hour, user_key, target)
);

-- Sign-in attempts and their outcome.
CREATE TABLE IF NOT EXISTS artifact_signins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '',
  -- silent | code_sent | code_no_access | code_capped | code_no_email | code_wrong | code_ok
  -- | account_off | grant_ok | grant_failed
  result text NOT NULL,
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_signins_artifact_idx ON artifact_signins (artifact_id, created_at);

-- Errors, grouped: one row per distinct error per artifact, with a count.
-- kind = error | rejection | console | network (from the page) | api | server.
CREATE TABLE IF NOT EXISTS artifact_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  stack text NOT NULL DEFAULT '',
  path text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  -- Distinct people who hit it, up to 100.
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  count integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_errors_fp_uniq ON artifact_errors (artifact_id, fingerprint);
CREATE INDEX IF NOT EXISTS artifact_errors_seen_idx ON artifact_errors (artifact_id, last_seen);

-- Every create, update and delete of a record or blob: who, when, before and after.
CREATE TABLE IF NOT EXISTS artifact_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'record',   -- record | blob
  target text NOT NULL,                  -- collection or blob name
  record_id text NOT NULL DEFAULT '',
  action text NOT NULL,                  -- create | update | delete
  before jsonb,
  after jsonb,
  actor_id uuid,
  actor_email text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_revisions_record_idx ON artifact_revisions (artifact_id, record_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_revisions_artifact_idx ON artifact_revisions (artifact_id, created_at);

-- "Report a Problem" from the footer on every artifact page.
-- kind = broken (goes to the owner) | abuse (goes to the platform's admins).
CREATE TABLE IF NOT EXISTS artifact_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  message text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',   -- open | closed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_reports_idx ON artifact_reports (kind, status, created_at);
