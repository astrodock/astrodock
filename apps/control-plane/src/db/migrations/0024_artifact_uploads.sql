-- Files people attach to records, for collections that allow it
-- (manifest: "attachments"). Bytes in the object store under
-- artifacts/<public_id>/_uploads/<id>; served with a sandbox policy.
CREATE TABLE IF NOT EXISTS artifact_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  collection text NOT NULL,
  record_id uuid NOT NULL,
  name text NOT NULL,
  size integer NOT NULL DEFAULT 0,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  uploader_id uuid,
  uploader_email text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_uploads_record_idx ON artifact_uploads (artifact_id, record_id);

-- Bytes served by public artifacts, per calendar month (UTC), for the plan's cap.
CREATE TABLE IF NOT EXISTS artifact_egress (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  month text NOT NULL,
  bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, month)
);
