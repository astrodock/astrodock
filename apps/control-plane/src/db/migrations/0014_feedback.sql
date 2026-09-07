-- Feedback from an app's users, and the work it turns into.
--
-- Two things, deliberately separate. Feedback is what a person said, and it
-- always ends in a reply to that person. A work item is what the operator is
-- going to do about it, and no user is waiting on one directly, so it can carry
-- as much technical detail as it likes. Some feedback is only a question and
-- never becomes an item; one bug reported by a dozen people is one item.
--
-- The join is therefore a link table rather than a column on either side.
--
-- See FEEDBACK_DESIGN.md.

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- F-1 upward, per app. Users quote these back at you, so they are short and
  -- they never change.
  key text NOT NULL,
  -- Null for anonymous submissions, which an app has to opt into.
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitter_email text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'other',
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  -- new | under_review | planned | in_progress | shipped | answered | declined.
  -- Carried over from the CCM project, which has run them against real users.
  -- `answered` closes a question; `shipped` closes something that became work.
  status text NOT NULL DEFAULT 'new',
  -- url, viewport, user agent, app version, deploy id. Whatever the widget could
  -- see at the moment of submission, which is the part nobody can reconstruct.
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Reserved for a stored DOM snapshot. Nothing writes it yet: capturing one
  -- means taking whatever was on the user's screen, and that is worth building
  -- deliberately rather than shipping an option that quietly does nothing.
  snapshot_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_app_key_uniq ON feedback (app_id, key);
CREATE INDEX IF NOT EXISTS feedback_app_status_idx ON feedback (app_id, status);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);
-- The /mine lookup for someone the app identified by email rather than by a
-- platform user id.
CREATE INDEX IF NOT EXISTS feedback_submitter_email_idx ON feedback (app_id, submitter_email)
  WHERE submitter_email <> '';

-- Messages on a feedback item, in two threads that share a table.
--
-- THE INVARIANT THIS FILE EXISTS TO ENFORCE: a message is either internal or
-- visible to the person who submitted the feedback, the column has NO DEFAULT,
-- and the value is set by the route rather than passed in by a caller. An
-- operator's diagnosis, a stack trace, or an agent's reasoning about the cause
-- must never appear to the user. Making that a flag someone remembers to set
-- would make it a matter of remembering; the API has no visibility parameter
-- anywhere, so nothing can pass the wrong one.
CREATE TABLE IF NOT EXISTS feedback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('internal', 'user')),
  author_kind text NOT NULL DEFAULT 'operator' CHECK (author_kind IN ('user', 'operator', 'agent')),
  author_id text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  -- An AI draft waiting for a human to send it. A pending message is never shown
  -- to the user regardless of its visibility.
  pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_messages_thread_idx
  ON feedback_messages (feedback_id, visibility, created_at);

CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key text NOT NULL,                        -- I-1 upward, per app
  title text NOT NULL DEFAULT '',
  -- One-line problem statement shown under the title in a list, which is the
  -- field that makes a list of thirty items readable.
  context text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',      -- open | in_progress | done | wont_do
  priority text NOT NULL DEFAULT 'P2',
  size text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'bug',         -- bug | feature | chore
  area text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS work_items_app_key_uniq ON work_items (app_id, key);
CREATE INDEX IF NOT EXISTS work_items_app_status_idx ON work_items (app_id, status);

-- relates_to | blocks | parent | duplicate_of | supersedes, carried over from
-- the CCM tracker where they earned their place.
CREATE TABLE IF NOT EXISTS work_item_relations (
  from_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  kind text NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

CREATE TABLE IF NOT EXISTS feedback_work_items (
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  PRIMARY KEY (feedback_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS feedback_work_items_item_idx ON feedback_work_items (work_item_id);

-- Per-app sequential keys (F-1, I-1). A counter row incremented atomically,
-- rather than MAX(key)+1, which races: two people submitting feedback at the
-- same moment would both read the same maximum and one insert would lose to the
-- unique index. A number is claimed before the row is inserted, so a failed
-- insert leaves a gap. Gaps are fine; two people holding F-12 is not.
CREATE TABLE IF NOT EXISTS app_counters (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind text NOT NULL,                       -- 'feedback' | 'work'
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, kind)
);

-- Per-app feedback configuration, filled in from the app.json `feedback` block.
-- Inert until the intake routes read it; here so this is one migration rather
-- than two. Shape: { enabled, widget, anonymous, snapshot, categories[],
-- ai_mode, webhook }.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS feedback_config jsonb NOT NULL DEFAULT '{}'::jsonb;
