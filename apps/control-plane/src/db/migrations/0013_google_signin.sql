-- Google sign-in, for operators and for end users of hosted apps.
--
-- Accounts are linked by Google's `sub`, not by email. An email address can
-- change hands; a subject id cannot, and matching on email alone means whoever
-- controls an address at Google controls the account here.
--
-- google_email is kept alongside it only so the UI can show which Google
-- account is linked. It is never the thing matched on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_linked_at timestamptz;

-- One Google identity, at most one account.
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uniq ON users (google_sub)
  WHERE google_sub IS NOT NULL;

-- Whether a Google sign-in by a stranger creates an end-user account for this
-- app. Off by default, and it never applies to operator accounts: a dashboard
-- login is always an invitation, never a self-service signup.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS allow_google_signup boolean NOT NULL DEFAULT false;
