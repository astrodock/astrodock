# Starter App

A minimal but real Astrodock app: a Vite/React frontend (`app/`) and an Express server
(`server/`) wired to **platform login**. Copy this directory to a new GitHub repo to start your own.

## What it shows
- The `app/` + `server/` layout the runner auto-detects.
- Binding `ASTRODOCK_PORT` and namespacing routes under `/api`.
- The platform auth flow: verify credentials against the control plane, then mint your own
  session JWT (`server/server.js`).
- Reading injected config from the environment, declared extras via `app.json`.

## Run locally
```bash
# terminal 1 — server
cd server && npm install && ASTRODOCK_PORT=3000 npm start

# terminal 2 — frontend (proxies /api → :3000)
cd app && npm install && npm run dev
```
For real login locally, point `ASTRODOCK_AUTH_URL` at a running control plane and set
`ASTRODOCK_APP_ID` / `ASTRODOCK_APP_SECRET` (see `.env.example`).

## Deploy to an Astrodock platform
```bash
export ASTRODOCK_URL=https://admin.your-domain     # your platform's admin host
export ASTRODOCK_TOKEN=tk_...                       # a scoped token from the admin UI

astrodock apply                  # create/update from app.json + connect repo + provision
astrodock deploy:watch           # deploy and stream the log
```
Then grant a user access to the `starter` app in the admin UI and log in at
`https://starter.your-domain`.

See **`AGENTS.md`** for the full contract.
