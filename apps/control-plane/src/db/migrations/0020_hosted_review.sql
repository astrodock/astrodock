-- Follow-ups from the security review of the hosted work.
--
-- The CLI's public key for an astrodock login. The key it collects is sealed
-- to this, so whoever relays the sign-in, or learns its device code and
-- verifier, still cannot read the key. The check code people compare between
-- the terminal and the approval page is derived from it and the challenge.
ALTER TABLE cli_logins ADD COLUMN IF NOT EXISTS client_public_key text;

-- What a session may do. 'welcome' is a session opened by an owner's welcome
-- link: it can set up sign-in and nothing else, until it has.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS purpose text;
