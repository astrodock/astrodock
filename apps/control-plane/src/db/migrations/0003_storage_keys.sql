-- #2: per-app object-storage credentials (scoped key per app). Nullable — when
-- the object store can't mint a scoped identity, these stay null and the app
-- falls back to the shared platform key + per-app prefix (logged).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_bucket     text;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_access_key text;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_secret_key text;
