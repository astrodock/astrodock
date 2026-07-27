-- Stage 18 — auth, identity & agent permissions. See AUTH_DESIGN.md.
--
-- Three shifts:
--   1. operator_role replaces is_admin, so "may use the dashboard" becomes a role
--      rather than a boolean, while app_access stays independent — the same person
--      is routinely both an operator and an end user of their own apps.
--   2. password_hash becomes NULLABLE. An account may authenticate by passkey only.
--   3. Credentials, sessions and authorization codes become first-class rows.

-- ── operators ─────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_role text;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;          -- AES-GCM via lib/crypto
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_confirmed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;     -- replay rejection
ALTER TABLE users ADD COLUMN IF NOT EXISTS passwordless boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Existing admins become 'admin'. The oldest one becomes 'owner', because an
-- install must always have exactly one account that cannot be locked out, and the
-- first admin created is the closest thing the old model had to that.
UPDATE users SET operator_role = 'admin' WHERE is_admin = true AND operator_role IS NULL;
UPDATE users SET operator_role = 'owner'
 WHERE id = (SELECT id FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1);

CREATE INDEX IF NOT EXISTS users_operator_role_idx ON users (operator_role)
  WHERE operator_role IS NOT NULL;

-- ── passkeys ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  text NOT NULL,               -- base64url
  public_key     text NOT NULL,               -- base64url COSE key
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     jsonb NOT NULL DEFAULT '[]'::jsonb,
  label          text NOT NULL DEFAULT '',
  rp_id          text NOT NULL DEFAULT '',    -- host it was enrolled against
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
-- Globally unique: a credential id identifies one credential, not one per user.
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_credential_id_uniq
  ON webauthn_credentials (credential_id);
CREATE INDEX IF NOT EXISTS webauthn_user_idx ON webauthn_credentials (user_id);

-- ── recovery codes ────────────────────────────────────────────────────────────
-- Hashed like passwords: they are single-use credentials, and a database dump
-- should not hand over someone's break-glass.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);

-- ── sessions ──────────────────────────────────────────────────────────────────
-- Dashboard sessions were an 8h JWT with no revocation: a stolen session could not
-- be killed. The JWT now carries a session id checked on every request.
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  -- When the second factor was last satisfied. Step-up actions require this to be
  -- recent, independent of how long the session itself has been alive.
  reauth_at     timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ── hosted login ──────────────────────────────────────────────────────────────
-- Codes are a table rather than a signed blob so single-use is enforced by an
-- UPDATE, instead of needing a replay cache that would be a table anyway.
CREATE TABLE IF NOT EXISTS authorization_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash    text NOT NULL,
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS authorization_codes_hash_uniq ON authorization_codes (code_hash);
CREATE INDEX IF NOT EXISTS authorization_codes_expiry_idx ON authorization_codes (expires_at);

-- Exact-match allowlist. Prefix matching is how authorization codes get stolen.
CREATE TABLE IF NOT EXISTS app_redirect_uris (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  uri        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_redirect_uris_uniq ON app_redirect_uris (app_id, uri);

-- ── agent keys ────────────────────────────────────────────────────────────────
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- The human at the root of the delegation chain. A key minted by a key inherits
-- this, so "who authorised this action" survives renames and revocations.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS authorized_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS created_by_token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
