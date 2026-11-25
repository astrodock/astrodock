# Artifacts: AI-built mini apps with a declarative backend

Status: milestone 1 built (Testing). See Build Status at the end. Working name "artifacts".

An artifact is an HTML/CSS/JS page an AI agent writes, plus a manifest that declares its data,
its roles, and a short list of built-in actions. The platform serves it, signs people in, and
enforces the manifest. The page never handles auth. Artifacts replace Pages.

## Decisions

| # | Decision | Choice |
|---|---|---|
| A1 | Server logic | Declarative only: collections, blobs, rules, validation, plus a fixed list of built-in actions. No user-supplied server code |
| A2 | Roles | A ladder. Each artifact names its own roles; `owner` is always the top; each role includes everything below it |
| A3 | Field rules | Rules may compare a field to the viewer's email (`assignee == me.email`). Nothing more expressive |
| A4 | Sign-in | One account per email. Each artifact has its own session on its own subdomain |
| A5 | Account members | People on the top-level account see every artifact they can access and open it without a code (silent sign-in through `/authorize`) |
| A6 | Guests | People an artifact is shared with by email sign in with a 6-digit code sent to that email, once per artifact per device |
| A7 | Isolation | Each artifact is served from its own origin, `<id>.<artifacts-host>`. Cookies are host-only |
| A8 | Capability feedback | An agent that hits something the framework cannot do submits a feedback item. This is part of the agent instructions |
| A9 | Where it runs | Both: a feature of every Astrodock instance, and a multi-tenant hosted service |
| A10 | Product | An option under Astrodock. No separate name or signup |
| A11 | Feedback destination | Capability feedback goes upstream to the Astrodock project, from every instance including self-hosted |
| A12 | Live updates | In the first version (`subscribe`) |
| A13 | Viewer uploads | Yes, as attachments on records, with a storage cap per artifact |
| A14 | Pages migration | Each page becomes an artifact; its `_data` becomes a blob named `data` |
| A15 | Plans | Free (multi-tenant, tight caps), Creator at $10/month per creator (multi-tenant), then the instance plans ($25/$50/$100). Viewers are free on every plan |
| A16 | Free caps (starting point) | 3 artifacts, 10 guests per artifact, limited storage, low daily caps on invites and `email`/`digest` actions |
| A17 | Public artifacts | Paid plans only |
| A18 | Serving domain | `adock.app` for the hosted service, listed on the Public Suffix List. Self-hosted default `artifacts.<base-domain>` |
| A19 | Signup | One page an agent sends the person to, email already filled in; Send Code, enter the code, account created. See Signup page below |

## Manifest

Carried with the artifact's files as `artifact.json`.

```json
{
  "roles": ["owner", "manager", "staff", "viewer"],
  "collections": {
    "tasks": {
      "read": "viewer",
      "create": "staff",
      "update": ["manager", "author", { "field": "assignee", "is": "me.email" }],
      "delete": ["owner", "author"],
      "fields": { "title": "string", "done": "boolean", "assignee": "email" }
    },
    "notes": { "scope": "per-user" }
  },
  "blobs": {
    "settings": { "read": "viewer", "write": "owner" }
  },
  "actions": [
    { "on": "tasks.create", "do": "email", "to": { "field": "assignee" }, "template": "New task: {{title}}" }
  ]
}
```

- A rule given as one role means that role and everything above it (A2).
- `author` is whoever created the record. The server stamps `id`, `author`, `createdAt`, `updatedAt`.
- `scope: per-user` gives each person their own records, invisible to others.
- `fields` is optional. Without it any JSON object is accepted; with it the server validates.
- A blob is one JSON document with a version check. It covers what Pages `_data` does today.

## Built-in actions (proposed first set)

| Action | What it does |
|---|---|
| `email` | Sends an email to a role, or to the address in a field, on create/update/delete |
| `digest` | One daily email to a role summarizing changes in a collection |
| `stamp` | Sets a field on a change (for example `completedAt` when `done` turns true) |
| `count` | A read-only endpoint that returns counts grouped by a field |

The list grows from capability feedback (A8), not up front.

## Client

A platform-served `astrodock.js`, loaded by every artifact:

- `db.<collection>.list(filter)`, `.get(id)`, `.add(obj)`, `.update(id, patch)`, `.remove(id)`, `.subscribe(cb)`
- `blob.<name>.get()`, `.set(obj, version)`
- `me()` returns `{ email, role }`
- `feedback(text)` for in-page feedback from people using the artifact

The same operations are on a REST API and on the agent surface.

## Sign-in

Reuses the hosted login and `/authorize` code flow apps already use (`routes/oauth.js`).

1. Artifact host has no session: redirect to `/authorize` with the artifact as the client.
2. Account member with a platform session and access: code returned at once, no prompt (A5). This
   is the existing "already signed in" path in `/authorize`.
3. Guest: login page asks for an email, sends a 6-digit code, checks it against the share list (A6).
4. Artifact host exchanges the code and sets a host-only session cookie for that artifact.

New: the email-code factor (none exists today), the share list per artifact, and the guest account
type, which cannot create artifacts.

## Sharing

Owner enters emails and picks a role. Each recipient gets an email with a link. Revoking a share ends
that person's sessions on that artifact.

## Agent surface

- Token scopes: `artifacts:read`, `artifacts:write`, `artifacts:data`.
- CLI and MCP tools: create, upload files, set manifest, share, read and write data, submit feedback.
- Agent instructions state the manifest format and the action list, and say: if the artifact needs
  something this setup cannot do, submit a feedback item describing what was needed, what was tried,
  and what workaround was used, then continue.

## Signup page

1. The agent starts a login session with the person's email (`astrodock login --email`, or the MCP
   tool). This is the existing `/cli/login/start` PKCE session, carrying the email server-side.
2. The agent gets back a `/start?code=…` link and gives it to the person. The email is not in the URL.
3. The page explains Astrodock in three lines, shows the email with a Change link, and a Send Code
   button. Nothing is emailed until the person presses it.
4. The person enters the 6-digit code. The account is created (or signed in, if it exists) and the
   agent's poll receives a key.
5. The page says to go back to the agent.

Limits: code sends capped per email and per IP, codes expire, a few attempts per code.

## UI

A reduced admin: folders, artifacts in each folder, a Share button, a file list with upload, a data
viewer per collection, and the feedback list. No deploys, env vars, or runners.

## Open

- Free storage number.
- Bandwidth limits.
- Scope of the key the signup page approves with only an email code (see the approval rule in
  `HOSTED_SERVICE.md`).
- What an upstream feedback item may contain (A11).

## Build Status

### Milestone 1: engine and dashboard (Testing)

| Piece | Where |
|---|---|
| Tables: artifacts, files, shares, records, blobs, codes, grants, sends, feedback, folders | `apps/control-plane/src/db/migrations/0021_artifacts.sql` |
| Manifest format, rule ladder, field validation | `src/lib/artifacts/manifest.js` |
| Records and blobs with rules, stamps, counts | `src/lib/artifacts/records.js` |
| Live updates (server-sent events, in-process) | `src/lib/artifacts/live.js` |
| `email` and `digest` actions, invite emails, daily caps | `src/lib/artifacts/actions.js` |
| Sessions per artifact host, grants, email codes | `src/lib/artifacts/access.js` |
| Artifact host: files, `/_astrodock/client.js`, `/_astrodock/api/*`, sign-in handoff | `src/routes/artifacts-public.js` |
| Sign-in pages on the auth host (silent for account members, code for guests) | `src/routes/artifacts-auth.js` |
| Management API for the dashboard and agents | `src/routes/admin-artifacts.js` |
| Capability feedback: kept locally, sent upstream; receiver | `src/lib/artifacts/feedback.js`, `src/routes/upstream.js` |
| Agent guide, served at `/admin/artifacts/guide` | `src/assets/artifacts-guide.md` |
| Scopes `artifacts:read`, `artifacts:write`, `artifacts:admin`; preset `artifacts` | `src/lib/scopes.js` |
| Caddy wildcard site `*.<artifacts domain>` with on-demand certificates | `src/provision/caddy.js` |
| Dashboard: folders, list, files, sharing, data, manifest, settings, feedback | `apps/admin/src/pages/Artifacts*.jsx` |

Settings: `ASTRODOCK_ARTIFACTS_DOMAIN`, `ASTRODOCK_ARTIFACT_MAX_FILE`, `_MAX_FILES`, `_MAX_RECORD`,
`_MAX_BLOB`, `_MAX_RECORDS`, `_INVITES_PER_DAY`, `_ACTION_EMAILS_PER_DAY`, `_CODES_PER_HOUR`,
`ASTRODOCK_UPSTREAM_FEEDBACK_URL`, `ASTRODOCK_ACCEPT_UPSTREAM_FEEDBACK`.

Upstream feedback goes to `https://auth.astrodock.ai/upstream/capability-feedback` by default. It
arrives only once the project's instance runs this version with `ASTRODOCK_ACCEPT_UPSTREAM_FEEDBACK=on`.

### Milestone 2: logging, error reports, admin views (Testing)

Decided 2026-11-25: log everything below; reporting-only error wrapper; record history; 90-day
retention; the multi-tenant service runs on its own instance (option A), with cloud.astrodock.ai as
the one account home (Instances, Artifacts, System Admin).

| Logged | How | Table |
|---|---|---|
| Page views and sign-in redirects | Every HTML page served | `artifact_views` |
| Writes and failed data calls | Every one, in full | `artifact_api_log` |
| Reads | Counted per artifact, person, target and hour | `artifact_read_counts` |
| Sign-in attempts | Every attempt and outcome | `artifact_signins` |
| Errors | From the page (client.js) and failed calls, grouped with counts and people | `artifact_errors` |
| Record and blob history | Before and after, who, when | `artifact_revisions` |
| Report a Problem | Footer link on every page; harmful ones raise an event | `artifact_reports` |

- The server adds `/_astrodock/client.js` to every HTML page; it reports errors and adds the
  Report a Problem link.
- Retention: `logging.artifact_log_retention_days` (default 90), pruned by the runner. Reports are kept.
- IP addresses follow `logging.page_view_ip`.
- Endpoints: `/admin/artifacts/usage`, `/reports`, `/:id/usage`, `/:id/activity`, `/:id/errors`,
  `/:id/history`, `/:id/reports`.
- Dashboard: Activity and Errors tabs, record history, and for owners and admins Everyone's
  Artifacts (usage, take down) and Harm Reports.

### Not built yet

1. Creator accounts on the multi-tenant service: a `creator` role that reaches artifacts only.
2. The signup page (A19) and the `artifacts`-scope key it hands out.
3. Plans and caps per plan (A15, A16); public artifacts limited to paid plans (A17).
4. Bandwidth caps (file-size cap exists; monthly egress cap does not).
5. Viewer file uploads (A13).
6. Pages migration (A14).
7. CLI commands and an MCP server for artifacts.
8. The cloud dashboard: Instances, Artifacts and System Admin at cloud.astrodock.ai, the service
   key to the artifacts instance, and launch-pass sign-in for creators.
9. Live updates across more than one control-plane process (today: one process, in-memory).
