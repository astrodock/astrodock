# AGENTS.md — building & deploying this app on Astrodock

This file travels with the app so any coding agent opened in this repo knows the
conventions. (Full platform contract: the root `AGENTS.md` and `docs/building-apps.md`.)

## Layout (auto-detected by the runner)
- `app/` — frontend (Vite/React). Builds to `app/dist/`, served by Caddy at the app's URL.
- `server/` — Express server, entry `server/server.js`. Reached at `/api/*` (same origin).
- A standalone `server.js` = server-only; a standalone `package.json` with no server = frontend-only.

## Hard rules
1. **Bind `process.env.ASTRODOCK_PORT`** in the server (the documented `PORT` alias also works).
2. **Namespace every server route under `/api`** — Caddy proxies `/api/*` to the server and serves
   the built frontend (with SPA fallback) for everything else.
3. **Read config from injected env; never hardcode.** The platform injects `ASTRODOCK_*` at deploy.
   Never commit secret values; `app.json` declares variable *names* only.
4. **Add a `GET /health` route** returning 200 — the platform probes it after deploy.

## Injected environment (depends on `app.json` modes)
Always: `ASTRODOCK_APP_SLUG`, `ASTRODOCK_APP_NAME`, `ASTRODOCK_APP_URL`, `ASTRODOCK_BASE_DOMAIN`,
`ASTRODOCK_PORT`, `ASTRODOCK_ENV`.
- `auth.mode = platform` → `ASTRODOCK_AUTH_URL`, `ASTRODOCK_APP_ID`, `ASTRODOCK_APP_SECRET`,
  `ASTRODOCK_APP_JWT_SECRET`.
- `database.mode != none` → `ASTRODOCK_DATABASE_URL` (+ `ASTRODOCK_DATABASE_ENGINE`).
- `storage.mode != none` → `ASTRODOCK_STORAGE_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY`
  (+ `ASTRODOCK_STORAGE_PREFIX` when internal).

Internal vs external is pure config — same variable names either way. Write the app once.

## Auth flow (platform login)
1. Frontend POSTs `{email, password}` to your `/api/login`.
2. Server POSTs to `${ASTRODOCK_AUTH_URL}/verify` with `appId=ASTRODOCK_APP_ID`,
   `appSecret=ASTRODOCK_APP_SECRET`. On success it returns `{userId, email, name}`.
3. Server mints its OWN session (here a JWT signed with `ASTRODOCK_APP_JWT_SECRET`) and sets a cookie.
   (`server/server.js` does this with plain `fetch`; `@astrodock/auth-client` wraps the same call.)
Users are managed in the admin UI; a user must be granted access to this app's slug to log in.

## Deploy lifecycle
```
astrodock apply         # create/update from app.json, connect repo, provision
astrodock set-secret K  # set any required secret value (reads stdin)
astrodock deploy:watch  # deploy and stream the log until success/failed
```
A deploy is blocked until every `required` declared var and every external-mode resource
credential has a value (the CLI prints exactly what's missing).
