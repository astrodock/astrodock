-- Changing the address an account signs in with.
--
-- There was no way to do it at all: the admin PATCH took name, isActive and
-- operatorRole, the admin panel rendered the field disabled on purpose, and the
-- hosted account page only changed passwords. An address typed into an invite
-- was permanent.
--
-- That became worse when invites arrived, because the address is also the key
-- Google linking matches on for a first sign-in. Someone invited at the wrong
-- address could neither correct it nor link the Google account they actually
-- use.
--
-- An operator may now set it directly. A person changing their OWN address has
-- to prove they control the new one, which is what this table is for: an
-- unverified self-service change would let someone park their account on a
-- colleague's address, and the next invite sent to that colleague would land on
-- the account already holding it.

CREATE TABLE IF NOT EXISTS email_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email text NOT NULL,
  -- sha256 of the token, which only ever exists in the one email that carries it.
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_changes_token_uniq ON email_changes(token_hash);
CREATE INDEX IF NOT EXISTS email_changes_open ON email_changes(user_id) WHERE confirmed_at IS NULL;
