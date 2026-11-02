-- Agent sign-in, approvals, per-app limits and traffic. See HOSTED_SERVICE.md.
--
-- An agent gets a key by running `astrodock login`. The CLI starts a sign-in
-- here, a person approves it in the dashboard with a passkey or authenticator
-- code, and the CLI collects the key once. Only hashes of the device code are
-- stored, and the code is redeemable only with the verifier whose S256 hash is
-- the challenge, so whoever relays the code cannot collect the key with it.
CREATE TABLE IF NOT EXISTS cli_logins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL,
  user_code text NOT NULL,
  code_challenge text NOT NULL,
  -- What the CLI said about where it runs: host name, folder, git remote. Shown
  -- to the person approving, never trusted for anything else.
  client jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The app.json from the folder, if there was one. Validated on arrival.
  manifest jsonb,
  source text NOT NULL DEFAULT 'cli',
  status text NOT NULL DEFAULT 'pending',
  kind text,
  app_slug text,
  approved_by_user_id uuid,
  token_id uuid,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cli_logins_device_uniq ON cli_logins(device_code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS cli_logins_user_code_uniq ON cli_logins(user_code);
CREATE INDEX IF NOT EXISTS cli_logins_expires_idx ON cli_logins(expires_at);

-- An action an access key asked for that reaches beyond one app: creating an
-- app, giving an app an existing person, adding a domain. The key gets an
-- approval link instead of the result. A person approves it with a passkey or
-- authenticator code, and the key repeats the same request naming the approval.
-- Bound to the key and to a hash of the exact request, and spent on use.
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  token_id uuid NOT NULL,
  token_name text NOT NULL DEFAULT '',
  required_scope text NOT NULL,
  request_hash text NOT NULL,
  summary text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  decided_by_user_id uuid,
  decided_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_token_idx ON approvals(token_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);

-- A single-use link for an owner account created with no way to sign in yet:
-- the hosted service creates the owner by email, and the link is how that
-- person sets up a passkey, or a password and authenticator app.
CREATE TABLE IF NOT EXISTS owner_setup_links (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Node apps can run in a container of their own instead of under PM2 in the
-- runner. Recorded per app, by the deploy that did it, so routing follows what
-- is actually running rather than what the platform is set to do next.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS node_isolation text NOT NULL DEFAULT 'pm2';
-- Per-app caps. Null takes the platform default.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS memory_mb integer;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS cpu_millis integer;

-- Bytes in and out of each app's container, per hour. Read from the container's
-- own counters, so only apps that run in a container are counted.
CREATE TABLE IF NOT EXISTS app_traffic (
  app_slug text NOT NULL,
  hour timestamptz NOT NULL,
  rx_bytes bigint NOT NULL DEFAULT 0,
  tx_bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (app_slug, hour)
);

CREATE INDEX IF NOT EXISTS app_traffic_hour_idx ON app_traffic(hour);
