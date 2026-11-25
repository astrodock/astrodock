-- Artifacts: AI-built mini apps with a declarative backend (docs/plans/artifacts.md).
--
-- An artifact is a set of files plus a manifest (roles, collections, blobs,
-- actions). Each one is served from its own origin, <public_id>.<artifacts domain>.

CREATE TABLE IF NOT EXISTS artifact_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_folders_owner_idx ON artifact_folders (owner_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 12 lowercase letters and digits: the first label of the artifact's host.
  public_id text NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  folder_id uuid REFERENCES artifact_folders(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  entry_file text NOT NULL DEFAULT 'index.html',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- shared: sign-in required, only people on the share list.
  -- public: anyone may open it; the manifest's "public" level applies to them.
  visibility text NOT NULL DEFAULT 'shared',
  is_active boolean NOT NULL DEFAULT true,
  suspended_at timestamptz,
  suspended_reason text NOT NULL DEFAULT '',
  -- Raising it ends every session on the artifact.
  session_epoch integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_public_id_uniq ON artifacts (public_id);
CREATE INDEX IF NOT EXISTS artifacts_owner_idx ON artifacts (owner_id);

CREATE TABLE IF NOT EXISTS artifact_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name text NOT NULL,
  size integer NOT NULL DEFAULT 0,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_files_name_uniq ON artifact_files (artifact_id, name);

-- Who an artifact is shared with, and as what. Email is the identity: the
-- person may not have an account until they first sign in.
CREATE TABLE IF NOT EXISTS artifact_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_shares_email_uniq ON artifact_shares (artifact_id, email);
CREATE INDEX IF NOT EXISTS artifact_shares_email_idx ON artifact_shares (email);

-- Records in a collection. author_id is stamped by the server; for a per-user
-- collection it is also who may see the record.
CREATE TABLE IF NOT EXISTS artifact_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  collection text NOT NULL,
  author_id uuid,
  author_email text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  size integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_records_coll_idx ON artifact_records (artifact_id, collection, created_at);
CREATE INDEX IF NOT EXISTS artifact_records_author_idx ON artifact_records (artifact_id, collection, author_id);

-- One JSON document per name (shared) or per name and person (per-user).
CREATE TABLE IF NOT EXISTS artifact_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name text NOT NULL,
  user_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_blobs_shared_uniq ON artifact_blobs (artifact_id, name) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS artifact_blobs_user_uniq ON artifact_blobs (artifact_id, name, user_id) WHERE user_id IS NOT NULL;

-- Email sign-in codes. Stored as a hash; a code is for one email and one artifact.
CREATE TABLE IF NOT EXISTS artifact_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  ip text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_codes_email_idx ON artifact_codes (email, created_at);

-- The one-time handoff from the sign-in host to the artifact's own host.
CREATE TABLE IF NOT EXISTS artifact_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_grants_code_uniq ON artifact_grants (code_hash);

-- Messages the platform sent on an artifact's behalf (invites, the email
-- action). The source for the daily caps.
CREATE TABLE IF NOT EXISTS artifact_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
  owner_id uuid,
  kind text NOT NULL,              -- invite | action | code
  recipient text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_sends_owner_idx ON artifact_sends (owner_id, kind, created_at);
CREATE INDEX IF NOT EXISTS artifact_sends_artifact_idx ON artifact_sends (artifact_id, kind, created_at);

-- Capability feedback: what an agent building an artifact needed and the
-- framework could not do. Kept here and sent upstream to the Astrodock project.
-- source = local (written on this instance) | upstream (received from another).
CREATE TABLE IF NOT EXISTS artifact_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'local',
  artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  needed text NOT NULL,
  tried text NOT NULL DEFAULT '',
  workaround text NOT NULL DEFAULT '',
  manifest jsonb,
  platform_version text NOT NULL DEFAULT '',
  actor text NOT NULL DEFAULT '',
  upstream_status text NOT NULL DEFAULT 'pending', -- pending | sent | failed | none
  upstream_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_feedback_created_idx ON artifact_feedback (created_at);
