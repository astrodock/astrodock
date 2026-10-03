-- Inviting an end user, instead of choosing their password for them.
--
-- Creating an account used to require a password in the request body, which
-- meant whoever ran the dashboard picked a password for someone else and then
-- had to transmit it. An invite replaces that: the account is created with no
-- credential and no access, and the person who receives the link establishes
-- both themselves.
--
-- The gate is app_access, not is_active. An invited account can already be
-- looked up by email, so it has to be inert without being "disabled" — a
-- disabled account is refused by Google sign-in before it can ever be linked.
-- With no password hash and no app in app_access, both sign-in paths already
-- decline, so redemption is simply the act that grants access.
--
-- redirect_to is where the app wants the person to land afterwards. It is
-- validated against that app's own hostnames on the way in, so a stolen admin
-- credential cannot turn an invite into an open redirect.

CREATE TABLE IF NOT EXISTS user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- sha256 of the token. The token itself is returned once, at creation, and
  -- is never recoverable from here: a leaked database dump cannot redeem.
  token_hash text NOT NULL,
  invited_by_name text NOT NULL DEFAULT '',
  redirect_to text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_invites_token_uniq ON user_invites(token_hash);
CREATE INDEX IF NOT EXISTS user_invites_user ON user_invites(user_id);
-- One live invite per person per app is the normal state; the partial index
-- makes "is there one outstanding" cheap without forbidding a second.
CREATE INDEX IF NOT EXISTS user_invites_open ON user_invites(user_id, app_id) WHERE redeemed_at IS NULL;
