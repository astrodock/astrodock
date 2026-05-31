# AGENTS.md — building & launching apps on Toolstead

You are an AI coding agent pointed at a **Toolstead** platform. Your job: build a small app and
**launch it on the open internet** through the documented contract below. This file is the
source of truth for that contract; `docs/building-apps.md` is the long-form version with
examples and the full env catalog.

> If you're working *inside an app's repo*, read that repo's own `AGENTS.md` too (the starter
> emits one). This file is the platform-level contract.

## The 60-second model
A Toolstead platform deploys, hosts, authenticates, routes, and monitors small apps on one box.
You give it a Git repo with an **`app.json`** manifest; it provisions resources, injects config
as environment variables, builds, runs, and serves the app at `https://<subdomain>.<base-domain>`.
You drive the whole loop with the **`toolstead` CLI** (or the admin UI).

## 1. Scaffold
Start from `examples/starter-app` (frontend `app/` + server `server/`, wired to platform login).
Copy it into a new Git repo. Keep the `app/` + `server/` layout — the runner auto-detects it.

## 2. App layout contract
- `app/` — frontend. Builds to `app/dist/` (via `runtime.buildCommand`, default `npm run build`).
  Served by Caddy at the app URL with SPA fallback.
- `server/` — Express server, entry `server/server.js`. Reached at `/api/*` (same origin → no CORS).
- Shortcuts: a standalone `server.js` (no `app/`/`server/`) = server-only; a standalone
  `package.json` = frontend-only.
- **Docker apps** (`runtime.type: "docker"`): ship a `Dockerfile`; the container serves the whole
  subdomain itself on `TOOLSTEAD_PORT`. No `app/`+`server/` split.

### Hard rules for the server
1. **Bind `process.env.TOOLSTEAD_PORT`** (the unprefixed `PORT` alias is also exported).
2. **Namespace all routes under `/api`.**
3. **Add `GET /health` → 200** (the platform probes it).
4. **Read config from injected env. Never hardcode. Never commit secrets.**

## 3. The `app.json` manifest
Lives at the repo root (or at `source.repoPath`). Declares config and env-var **names only —
never secret values**. Validate it against `packages/schema/app.schema.json`.

```json
{
  "schemaVersion": "1",
  "slug": "invoice-tool",
  "name": "Invoice Tool",
  "subdomain": "invoices",
  "source": { "branch": "main", "repoPath": "" },
  "runtime": { "type": "node", "buildCommand": "npm run build" },
  "auth":     { "mode": "platform" },
  "database": { "mode": "internal" },
  "storage":  { "mode": "internal" },
  "env": [
    { "key": "OPENAI_API_KEY", "secret": true, "required": true, "description": "Drafts line items" }
  ]
}
```
- `slug` is the immutable identity (PM2 process / container / internal DB name). `subdomain` is mutable.
- `auth.mode`: `platform` (login backed by the control plane) | `public`.
- `database.mode` / `storage.mode`: `internal` (platform-provisioned) | `external` (you supply
  creds) | `none`.
- `env[].key` must be `UPPER_SNAKE_CASE` and must **not** start with `TOOLSTEAD_` (reserved).

**Present the resource choices to the human when building an app.** Internal = easiest
("fine, not fantastic"); external = bring your own Neon/Supabase/RDS/S3/R2 for heavier needs;
none = the app doesn't use it. App code is identical for internal vs external — only values differ.

## 4. Environment model (two categories, kept strictly separate)
1. **Reserved `TOOLSTEAD_*`** — the platform injects these at deploy; the app only *reads* them.
   You may never declare them.
2. **App-declared** — from `app.json` `env[]`; values set out-of-band (`toolstead set-secret` /
   admin UI). Secret values never live in the repo.

Reserved vars injected (depends on modes) — see `docs/building-apps.md` for the full table:
`TOOLSTEAD_APP_SLUG/NAME/URL/BASE_DOMAIN/PORT/ENV` (always);
`TOOLSTEAD_AUTH_URL/APP_ID/APP_SECRET/APP_JWT_SECRET` (auth=platform);
`TOOLSTEAD_DATABASE_URL` (+`_ENGINE`) (database≠none);
`TOOLSTEAD_STORAGE_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY` (+`_PREFIX` internal) (storage≠none).
The single documented unprefixed alias is `PORT = TOOLSTEAD_PORT`.

## 5. Auth integration (`auth.mode = platform`)
The platform answers "are these end-user credentials valid for this app?". Your app mints its own
session. Flow:
1. Frontend → your `POST /api/login` with `{email, password}`.
2. Server → `POST ${TOOLSTEAD_AUTH_URL}/verify` with `appId=TOOLSTEAD_APP_ID`,
   `appSecret=TOOLSTEAD_APP_SECRET`. Returns `{userId, email, name}` (or 401 invalid / 403 no-access).
3. Server signs its own session (e.g. JWT with `TOOLSTEAD_APP_JWT_SECRET`), sets a cookie.

Use `@toolstead/auth-client` (`new ToolsteadAuth().verify(email, password)`) or call `/verify`
directly (see `examples/starter-app/server/server.js`). A user must be granted access to the
app's slug (admin UI) to log in.

## 6. Deploy lifecycle (the CLI you drive)
Set `TOOLSTEAD_URL` (the admin host, e.g. `https://admin.example.com`) and `TOOLSTEAD_TOKEN`
(a scoped API token from the admin UI — tokens can manage apps/deploys/env but not users).

```bash
toolstead apply              # create/update the app from app.json, connect the repo, provision
toolstead set-secret KEY     # set a required secret value (value via arg or stdin)
toolstead deploy:watch       # trigger a deploy and STREAM the log until success/failed
toolstead status             # process status
toolstead logs --lines 200   # recent app logs
```
- `apply` is additive/non-destructive (won't delete user vars without `--prune`, never prints secrets).
- **Deploys are blocked** until every `required` declared var and every external-mode resource
  credential has a value — `deploy` prints exactly what's missing. Fix with `set-secret`, then redeploy.
- After `git push` to the watched branch, a webhook auto-deploys (if the repo is connected).
- `deploy:watch` is how you *confirm a launch succeeded* — poll/stream it until terminal.

## 7. Definition of done
`toolstead apply && toolstead deploy:watch` ends in `success`, `https://<subdomain>.<base-domain>`
serves the app, and (if `auth.mode=platform`) a granted user can log in.
