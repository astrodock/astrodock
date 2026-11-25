# Building Artifacts on Astrodock

An artifact is a small web app: HTML, CSS and JavaScript files you write, plus a
manifest that declares its data and who may do what. Astrodock serves it at its
own address, `https://<id>.{{ARTIFACTS_DOMAIN}}/`, signs people in, and enforces
the manifest. Your page never handles passwords, sessions or permissions.

Use an artifact for dashboards, to-do lists, trackers, sign-up sheets, simple
message boards and similar tools. For anything that needs its own server code,
deploy an app instead.

## When This Setup Cannot Do Something

If the artifact you are building needs something this framework does not offer
(a rule it cannot express, an action that does not exist, a limit that is too
low), do two things:

1. Send a feedback item: `POST /admin/artifacts/feedback` with
   `{ "artifactId": "<id>", "needed": "...", "tried": "...", "workaround": "..." }`.
   Say what you needed, what you tried, and what you did instead. This goes to
   the Astrodock project and decides what gets built next. The artifact's
   manifest is sent with it; records, email addresses and files are not.
2. Carry on with the best workaround, and tell the person what you could not do.

Send one item per missing capability. Do this every time, without asking first.

## After You Publish: Check for Errors

The platform adds `/_astrodock/client.js` to every HTML page it serves, so each
page reports its own errors: uncaught errors, rejected promises, `console.error`
calls and requests that failed. Failed data calls are recorded by the server.
Errors are grouped, with a count and the people who hit them.

After you publish or change an artifact, open it, then read
`GET /admin/artifacts/:id/errors` and fix what you find. Clear the list with
`DELETE /admin/artifacts/:id/errors` once fixed, so what comes back is new.
These are bugs in the page: fix them; they are not capability feedback.

The client also adds a small "Report a Problem" link to every page. Reports that
something is broken go to the owner (`GET /admin/artifacts/:id/reports`).

## Making an Artifact

All calls use your Astrodock key: `Authorization: Bearer tk_...`, against the
dashboard host (`https://admin.<domain>`).

```
POST   /admin/artifacts                      { title, manifest, files: [{ name, content }] }
GET    /admin/artifacts                      everything you own or can open
GET    /admin/artifacts/:id
PATCH  /admin/artifacts/:id                  { title, manifest, entryFile, folderId, visibility }
PUT    /admin/artifacts/:id/files            { files: [{ name, content, encoding? }] }  ("base64" for binary)
DELETE /admin/artifacts/:id/file?name=…
POST   /admin/artifacts/:id/shares           { emails: [...], role, notify? }
DELETE /admin/artifacts/:id/shares?email=…
GET    /admin/artifacts/:id/data/:collection  every record, as the owner sees it
GET    /admin/artifacts/:id/errors           errors from the page and failed data calls
GET    /admin/artifacts/:id/usage            views, people, writes, reads, storage, emails
GET    /admin/artifacts/:id/activity?kind=views|api|signins
GET    /admin/artifacts/:id/history?recordId=…  every change to a record: who, when, before, after
POST   /admin/artifacts/feedback             see above
```

The entry file is `index.html` unless you set `entryFile`. A path with no file
extension serves the entry file, so client-side routing works.

## Sharing

Artifacts are private to their owner until shared. Share by email and give each
person a role. They get an email with a link; when they open it, they enter their
email and get a 6-digit sign-in code. People on the Astrodock account itself are
signed in without a code. Removing someone from the share list ends their access
at once.

`visibility: "public"` lets anyone open the artifact without signing in. Only
rules that include `"public"` apply to them, and only for reading.

## The Manifest

```json
{
  "roles": ["owner", "manager", "staff", "viewer"],
  "collections": {
    "tasks": {
      "read": "viewer",
      "create": "staff",
      "update": ["manager", "author", { "field": "assignee", "is": "me.email" }],
      "delete": ["owner", "author"],
      "fields": {
        "title": { "type": "string", "required": true, "max": 200 },
        "done": "boolean",
        "assignee": "email",
        "due": "date",
        "status": { "type": "string", "enum": ["open", "blocked", "done"] }
      }
    },
    "notes": { "scope": "per-user" }
  },
  "blobs": {
    "settings": { "read": "viewer", "write": "owner" }
  },
  "actions": [
    { "on": "tasks.create", "do": "email", "to": { "field": "assignee" }, "subject": "New task: {{title}}" },
    { "on": ["tasks.create", "tasks.update"], "do": "stamp", "field": "completedAt", "when": { "field": "done", "is": true } },
    { "do": "digest", "collection": "tasks", "to": { "role": "manager" }, "hour": 13 }
  ]
}
```

### Roles

A ladder, highest first. The first role must be `owner`; the artifact's owner
always holds it. Each role can do everything the roles below it can. With no
`roles`, the ladder is `owner, editor, viewer`.

### Rules

Each operation names who may do it:

| Entry | Means |
|---|---|
| `"staff"` | that role and every role above it |
| `"author"` | whoever created the record (read, update, delete) |
| `{ "field": "assignee", "is": "me.email" }` | records whose field holds the viewer's email (read, update, delete) |
| `"public"` | anyone, signed in or not, on a public artifact (read only) |

A list grants access if any entry matches. Write the rules out. If you leave one
out, `read` goes to every role and the writes go to the role just above the lowest.

Collection operations: `read`, `create`, `update`, `delete`. Blob operations:
`read`, `write`.

### Collections

Records with an id. `scope: "per-user"` makes each person's records visible
only to them. `fields` is optional: without it any JSON object is accepted; with
it the server rejects unknown fields and wrong types, and tells you which.

Field types: `string` (up to 1000 characters unless `max` says otherwise),
`text`, `number`, `integer`, `boolean`, `email`, `date` (YYYY-MM-DD),
`datetime` (ISO 8601), `url`, `list`, `json`. Options: `required`, `min`,
`max`, `enum`.

The server sets `id`, `_author`, `_createdAt`, `_updatedAt` and `_version` on
every record. Field names cannot start with `_`.

### Blobs

One JSON document per name, for settings or anything that is not a list of
records. `scope: "per-user"` gives each person their own.

### Actions

The complete list:

| Action | What it does |
|---|---|
| `email` | On `<collection>.create`, `.update` or `.delete`, emails `{ "role": … }` (that role and above), `{ "field": … }` (an email field) or `{ "author": true }`. `subject` and optional `body` may use `{{field}}`. Optional `when: { field, is }`; on update it sends only when the condition becomes true. |
| `stamp` | On create or update, sets `field` to the time (`"value": "now"`, the default) or the viewer's email (`"value": "me.email"`). With `when`, it sets the field once the condition holds and clears it when it stops holding. |
| `digest` | Once a day at `hour` (UTC, default 13), emails a role a list of what was added or changed in a collection. Nothing changed, nothing sent. |

Email goes only to people who have access to the artifact. The person who made
a change is not emailed about it. Sends are capped per owner per day.

## The Page

Load the client from the artifact's own host:

```html
<script src="/_astrodock/client.js"></script>
<script type="module">
  const me = await astrodock.me();          // { signedIn, email, role, roles, permissions }
  const tasks = astrodock.db('tasks');
  const open = await tasks.list({ where: { done: false }, order: '-_createdAt', limit: 100 });
  const t = await tasks.add({ title: 'Call the vendor', assignee: 'sam@example.com' });
  await tasks.update(t.id, { done: true, _version: t._version });   // 409 if someone changed it first
  await tasks.remove(t.id);
  const { counts } = await tasks.count('status');
  const stop = tasks.subscribe(({ type, record }) => { /* create, update or delete */ });
  const settings = astrodock.blob('settings');
  const { data, version } = await settings.get();
  await settings.set({ ...data, theme: 'dark' }, version);
</script>
```

- `list` options: `where` (exact match on fields), `order` (a field, `_createdAt`
  or `_updatedAt`; prefix `-` for descending), `limit` (up to 1000), `offset`.
- `me().permissions` says, per collection and blob, whether the viewer can do
  each operation: `true`, `false`, or `"some"` (only records they wrote or are
  named on). Use it to hide controls the viewer cannot use.
- Errors throw with `.status`; a rejected record also has `.problems`, and a
  409 has `.current` (the record as it is now).
- `subscribe` uses server-sent events and reconnects by itself. Each viewer only
  receives changes to records they can read.
- `astrodock.signOut()` ends the viewer's session on this artifact.

The page can load anything from anywhere (fonts, chart libraries). Data calls go
only to `/_astrodock/api` on the artifact's own host. `astrodock.report(message)`
records an error of your own choosing.

## What Is Logged

Page views, every write, every failed call, sign-in attempts, errors, and the
before and after of every change are kept for 90 days (the operator can change
this). Reads are counted per hour. The owner and the platform's admins can see
them.

## Limits

| | Default |
|---|---|
| File size | 25 MB |
| Record size | 64 KB |
| Records per artifact | 50,000 |
| Blob size | 1 MB |
| Invites per owner per day | 100 |
| Action emails per owner per day | 200 |

If a limit gets in the way, send a feedback item.
