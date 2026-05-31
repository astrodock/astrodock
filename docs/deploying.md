# Deploying the Toolstead platform

Toolstead ships as a single `docker compose` stack with no external dependencies. The same
artifact runs locally, on any VPS, or (future) as a managed single-tenant instance. Nothing here
is DigitalOcean-specific — any box with Docker works.

## Requirements
- A host with Docker + the Compose plugin (any Linux VPS, a Mac, etc.).
- For public HTTPS: a domain and a **wildcard DNS record** `*.<base-domain>` → the host's IP
  (so `admin.<domain>` and every app subdomain resolve). Ports 80 + 443 reachable.

## 1. Configure
```bash
cp .env.example .env
```
Set at least:
- `TOOLSTEAD_BASE_DOMAIN` — your domain (apps live at `<subdomain>.<base-domain>`).
- `TOOLSTEAD_TLS_MODE` — `auto` (Let's Encrypt; needs public DNS) · `internal` (Caddy's own CA;
  LAN/dev) · `off` (plain HTTP behind another proxy).
- `TOOLSTEAD_ACME_EMAIL` — for `auto` TLS.
- `TOOLSTEAD_ADMIN_JWT_SECRET`, `TOOLSTEAD_ADMIN_EMAIL`, `TOOLSTEAD_ADMIN_PASSWORD` — admin login + seed.
- `TOOLSTEAD_PG_PASSWORD`, `TOOLSTEAD_OBJECTSTORE_SECRET_KEY` — bundled-resource secrets.
- `TOOLSTEAD_GITHUB_PAT` (+ `TOOLSTEAD_GITHUB_OWNER`) — a fine-grained PAT with `contents:read`
  and repo webhook read/write, so the platform can clone and auto-deploy on push.

Generate secrets with `openssl rand -hex 32`. **Never commit `.env`.**

## 2. Boot
```bash
docker compose up -d
docker compose ps
docker compose logs -f api
```
On first boot the control plane migrates the schema, seeds the admin, and pushes routing to Caddy.
Visit `https://admin.<base-domain>` (or `http://localhost` with `TLS_MODE=off`/`internal`) and log
in with the seeded admin.

## 3. Mint a token for the CLI / your agent
Admin UI → **Tokens** → create a scoped token. Then on your workstation:
```bash
export TOOLSTEAD_URL=https://admin.<base-domain>
export TOOLSTEAD_TOKEN=tk_...
```

## 4. Deploy an app
See `AGENTS.md` and `docs/building-apps.md`. In short: from an app repo with an `app.json`,
`toolstead apply && toolstead deploy:watch`.

## Local / LAN (no public domain)
```
TOOLSTEAD_BASE_DOMAIN=localhost
TOOLSTEAD_TLS_MODE=internal     # or off
```
With `internal`, Caddy issues certs from its own CA (your browser will warn unless you trust it).
With `off`, everything is plain HTTP — fine for a quick local poke, not for the internet.

## Backups
The bundled data lives in the `pgdata` and `objectdata` Docker volumes. `scripts/backup.sh` runs
`pg_dump` of the control-plane DB + every internal app DB and snapshots the object store into a
timestamped tarball. Run it via cron. For real durability, copy the tarball **off the box** (the
script has an env-gated hook to push it to an external S3 bucket — off by default).

> Single-box caveat: local backups protect against data corruption / fat-fingering, not against
> losing the box. Off-box copies are the one place an external dependency earns its keep.

## Upgrading
```bash
git pull
docker compose build api
docker compose up -d
```
Migrations run automatically on api start. App data in internal Postgres DBs is preserved.

## Operations
- Logs: `docker compose logs -f <service>` (`api`, `caddy`, `postgres`, `objectstore`).
- Per-app status/logs: the admin UI, or `toolstead status` / `toolstead logs`.
- Health monitoring + optional down/recovery emails: configure `TOOLSTEAD_RESEND_API_KEY` +
  `TOOLSTEAD_ALERT_EMAIL`.
- See `SECURITY.md` before exposing the box.
