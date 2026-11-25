-- The plan a person is on for artifacts, on the hosted artifacts service.
-- No row: no limits (an operator of a self-hosted install).
CREATE TABLE IF NOT EXISTS artifact_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free',
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
