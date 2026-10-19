-- Signing in from another system ("launch").
--
-- An operator can name one outside system as a trusted launcher and share a
-- secret with it. That system signs a short-lived pass saying who the person is
-- and which app they are opening; POST /launch checks it, finds or creates the
-- end user, grants that app, starts the platform session and sends them to the
-- app's own sign-in, which then completes without a form.
--
-- Each pass is single-use. Only the hash of its id is kept, and only until it
-- would have expired anyway.
CREATE TABLE IF NOT EXISTS launch_passes (
  jti_hash text PRIMARY KEY,
  issuer text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS launch_passes_expires_idx ON launch_passes(expires_at);

-- Where an app's own sign-in starts. /launch redirects here once the platform
-- session exists. The test apps and the documented pattern use /api/login.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS auth_login_path text NOT NULL DEFAULT '/api/login';
