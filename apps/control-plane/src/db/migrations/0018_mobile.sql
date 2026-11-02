-- The mobile app: devices, their sign-in, opening apps, and notifications.
-- See MOBILE_DESIGN.md.
--
-- A phone signs in once with a PKCE authorization code and keeps a device token.
-- Only the token's hash is stored, so a database dump cannot be replayed as a
-- device. It lapses after 90 days without use, and each use extends it.
--
-- push_handle is the relay's name for the device's APNs or FCM token. This
-- server never holds the raw token, so it can push only to devices that signed
-- in to it. push_public_key is the device's X25519 key; every notification is
-- encrypted to it, so the relay carries ciphertext only.
CREATE TABLE IF NOT EXISTS mobile_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  platform text NOT NULL,
  app_version text NOT NULL DEFAULT '',
  token_hash text NOT NULL,
  push_handle text,
  push_public_key text,
  push_environment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS mobile_devices_token_uniq ON mobile_devices(token_hash);
CREATE INDEX IF NOT EXISTS mobile_devices_user_idx ON mobile_devices(user_id);

-- The code /mobile/authorize hands back to the app. Single-use, 60 seconds,
-- stored hashed, and redeemable only with the verifier whose S256 hash is the
-- challenge: the app is a public client with no secret, so the verifier is what
-- stops another app on the phone from redeeming a code it intercepted.
CREATE TABLE IF NOT EXISTS mobile_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_codes_expires_idx ON mobile_codes(expires_at);

-- A one-time pass from a signed-in device to a WebView. The WebView has no
-- cookie of its own, so /mobile/open turns the ticket into the platform session
-- and the app's own sign-in then completes without a form. Bound to the device
-- and the app, single-use, 60 seconds, stored hashed.
CREATE TABLE IF NOT EXISTS mobile_tickets (
  ticket_hash text PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  path text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_tickets_expires_idx ON mobile_tickets(expires_at);

-- The inbox. An app writes here through POST /notify; operator alerts on the
-- push channel write here with app_id null. The push itself carries the same
-- text, encrypted, but the inbox is the record: Android shows generic text and
-- the app reads the real text from here. Kept 90 days.
CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id uuid REFERENCES apps(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_notifications_user_idx ON user_notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS user_notifications_created_idx ON user_notifications(created_at);
