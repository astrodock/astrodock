# Feedback and work items

How an app's users report something, how it reaches the operator, and how it
becomes tracked work.

This formalizes what the CCM project already does by hand (an in-app widget, a
`FEEDBACK_API_KEY` scoped to feedback routes, a `feedback-sync.mjs` CLI, and a
file-based `open-items/` tracker) into platform functionality every app on the
box gets for free.

## The shape

Two things, deliberately separate:

**Feedback** is what a user said. It always has a person attached and it always
ends in a reply to that person. Some of it is a question, which ends there.

**Work items** are what the operator is going to do. Most exist because of
feedback; some do not. A work item never has a user waiting on it directly, so
it can carry as much technical detail as it likes.

The join between them is a link table, not a foreign key on either side: one
piece of feedback can produce several items, and one item can answer a dozen
reports of the same bug.

## Decisions

| Decision | Choice |
|---|---|
| Intake | Platform-served widget by default, raw API always available |
| Work items | Rows in the control plane, not files in the app repo |
| Technical detail | Two threads per feedback item, internal and user-visible |
| AI | Per-app setting, drafts held for a human by default |

### Why the widget is the default

Auth already works this way: the platform hosts the sign-in page, an app opts in,
and an app that wants its own gets the API instead. Feedback follows it. One
script tag gives a button, a form, and context capture, and an app that skips the
widget still posts to the same endpoint.

The cost of API-only would be that every app re-solves the same problem, and
context capture is the part that gets skipped, which is exactly the part nobody
can reconstruct later.

### Why work items are rows, not files

CCM put items in `open-items/items/I-NNN.md` because there was no platform to put
them in. Astrodock is that platform: it already owns a dashboard, an audit trail,
and a scoped agent token. Rows are queryable across every app on the box, which
files in one app's repo can never be.

`astrodock work export` writes them out as markdown for anyone who wants the git
history, with the rows staying the source of truth.

### Why two threads and not one with a flag

The requirement is that a user sees an acknowledgement, a fix, and instructions
that mean something to them, and never a stack trace or a description of the
bug's cause.

One thread with a per-message visibility flag makes that a matter of remembering
the flag. Two threads make it a matter of calling the wrong endpoint. The API has
no parameter for visibility anywhere:

```
POST /api/feedback/:id/notes    always internal
POST /api/feedback/:id/reply    always visible to the submitter
```

Nothing accepts a visibility argument, so nothing can pass the wrong one. The
dashboard renders them as two panes, and the agent's tools are two tools.

### Why the AI drafts by default

A bad auto-reply reaches a real person and cannot be recalled. The agent triages,
writes internal notes, sets status, and drafts the reply. A draft sits as a
pending user-visible message with a Send button next to it.

`feedback.ai_mode` per app: `off`, `draft` (default), `auto`.

## Data model

Migration `0014_feedback.sql`.

```
feedback
  id, app_id, key                  F-1 upward, per app
  submitted_by                     end-user id, null when anonymous
  submitter_email                  captured when there is no account
  category                         from the app's configured list
  title, body
  status                           see below
  context jsonb                    url, viewport, user agent, app version, deploy id
  snapshot_key                     object storage key, null unless the app opts in
  created_at, updated_at, answered_at

feedback_messages
  id, feedback_id
  visibility                       'internal' | 'user', no default, set by the route
  author_kind                      'user' | 'operator' | 'agent'
  author_id, body
  pending                          true for an AI draft awaiting a human
  created_at

work_items
  id, app_id, key                  I-1 upward, per app
  title, body, context             one-line problem statement for the list view
  status, priority, size, type, area
  created_at, done_at

work_item_relations               from_id, to_id, kind
  kind: relates_to | blocks | parent | duplicate_of | supersedes

feedback_work_items               feedback_id, work_item_id
```

Statuses carry over from CCM, which has run them against real users:

- Feedback: `new`, `under_review`, `planned`, `in_progress`, `shipped`,
  `answered`, `declined`
- Work items: `open`, `in_progress`, `done`, `wont_do`

`answered` closes a question. `shipped` closes something that became work. Both
are terminal, and the difference is the reporting question worth being able to
ask later.

## Surfaces

**Widget.** Served by the platform on the shared auth host, so one entry covers
every app:

```html
<script src="https://auth.example.com/feedback.js" data-app="valise" defer></script>
```

Identity comes from the platform session when there is one. Context is collected
from the page. A DOM snapshot is off by default: CCM stores one and it is genuinely
useful for reproducing a layout bug, but it captures whatever was on the user's
screen, so it is per-app opt-in and stored in the app's own object storage.

**Dashboard.** Two tabs per app. Feedback lists by status with the user-visible
thread and the internal thread side by side. Work lists items with their linked
feedback, so closing an item shows who is waiting to hear about it.

**CLI and agent.** Mirrors `feedback-sync.mjs`, which is already the proven shape:

```
astrodock feedback list [--status S] [--app A]
astrodock feedback show F-12
astrodock feedback note F-12 "cause: the tz offset is applied twice"
astrodock feedback reply F-12 "Fixed. Reload the page and the time will stick."
astrodock feedback status F-12 shipped
astrodock feedback link F-12 I-45
astrodock work list [--status open]
astrodock work new "Time entry cannot be edited after selection" --type bug
astrodock work status I-45 done
```

New scopes, following the existing registry in `scopes.js`:

| Scope | Group | Covers |
|---|---|---|
| `feedback:read` | observe | Read feedback and internal notes |
| `feedback:write` | apps | Notes, status, links, and drafting replies |
| `feedback:reply` | sensitive | Sending a message a user will actually see |
| `work:read` / `work:write` | apps | Work items |

`feedback:reply` is separate and lives in the sensitive group because it is the
only one that reaches a person. An agent in draft mode does not hold it.

## What a developer can change

`app.json` gains a `feedback` block, all of it optional:

```json
{
  "feedback": {
    "enabled": true,
    "widget": true,
    "anonymous": false,
    "snapshot": false,
    "categories": ["bug", "idea", "question"],
    "ai_mode": "draft",
    "webhook": "https://example.com/hooks/feedback"
  }
}
```

Turning `widget` off leaves the API. Turning `enabled` off removes the routes.
The webhook fires on new feedback with the item and its context, which is the
seam for a developer whose process lives somewhere else entirely: they can take
the intake and the storage and run their own triage, or mirror items into
whatever tracker they already use.

What is deliberately not configurable: the split between internal and
user-visible messages, and the fact that sending to a user is its own scope. An
app can opt out of the whole feature, but it cannot opt into a shape where a
stack trace reaches a user by accident.

## Build order

1. Migration, domain model, and the visibility invariant with tests
2. Intake: the API endpoint, then the widget served from the auth host
3. Dashboard: Feedback tab and Work tab, two-pane thread
4. Scopes and CLI
5. AI drafting and the per-app mode
6. `app.json` schema and the outbound webhook

Each step is usable on its own. After 2 feedback arrives and can be read; after 3
it can be answered by a human; the agent path lands at 4 and 5.
