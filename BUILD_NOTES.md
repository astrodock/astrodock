# Build notes — running log

A chronological log of the unattended build, and (most importantly) the **verified vs.
unverified** status of each piece. See `DECISIONS.md` for the choices made along the way.

## Verification legend
- ✅ **verified** — exercised in this build environment (Node + local Postgres) and passing.
- 📦 **unverified-in-sandbox** — implemented to spec and read-reviewed, but needs a real Docker
  host to exercise end-to-end (Caddy routing, SeaweedFS, the Docker-app runner path).

## Environment available during the build
Node 24, npm 11, Docker 29 (CLI present; full compose stack not booted here), git 2.50,
Postgres 16 (local, via Homebrew — used as the live test DB).

---

## Log

### Stage 0 — repo init ✅
- `git init`, branch `main`, baseline commit `chore: initial fork…`. Secret scan clean.
- Git operations run with the sandbox disabled (the sandbox denies writes to `.git`).

### Stage 1 — monorepo skeleton + foundations ✅
- Workspace root `package.json` (npm workspaces: `apps/*`, `packages/*`).
- `git mv auth-api → apps/control-plane`, `auth-admin → apps/admin`; legacy docs → `docs/legacy/`.
- `@astrodock/auth-client` — rebranded, config-from-env defaults, `.d.ts` added. ✅
- `@astrodock/schema` — `app.json` JSON Schema (Draft 2020-12) + validator + reserved-env
  catalog + required-var helper. **11/11 unit tests pass.** ✅
- `@astrodock/cli`, `@astrodock/control-plane` package manifests written (deps installed).
- Deep de-brand of the control-plane source and admin UI happens inside their rewrite stages
  (3 and 7) since those files are being rewritten anyway. Final tree is grep-clean of
  `seniorverse` / `@sv` / "SV Platform".

### Stage 3 — Mongo → Postgres (Drizzle) ✅
- Drizzle schema + plain-SQL migration + minimal migration runner (verified against local PG 16).
- All routes ported off mongoose; new auth middleware (admin JWT OR scoped token).
- **12 integration tests pass** (health, admin login/authz, /verify success+failures, manifest
  apply incl. real internal-DB provisioning, rotate-secret, user CRUD+access, deploy gate, token authz).

### Stage 4 — env model + app.json + provisioning ✅
- Reserved `ASTRODOCK_*` computation + required-var gate (6 unit tests). Internal Postgres
  provisioner verified end-to-end (creates role+db). Internal storage provisioner + Caddy
  generator written; Caddy generation unit-tested.

### Stage 5 — runner (hybrid compute) ⚠️ partially verified
- Deploy trigger + gate verified (integration). Node-buildpack (PM2) deploy path and Docker
  (sibling-container) deploy path are 📦 **unverified-in-sandbox** — they need git + PM2 + the
  Docker socket inside the running stack. Code complete + read-reviewed.

### Stage 6 — CLI + scoped tokens ✅
- `@astrodock/cli` drives the live control plane. **7 CLI integration tests pass** (apply with
  real provisioning, apps, set-secret, status, deploy gate, app.json validation).

### Stage 2 — docker compose stack ✅ (booted & verified live in real containers)
- `docker compose build` succeeds; `docker compose up -d` boots all 4 services (postgres healthy).
- Control plane migrates + seeds + listens; pushes generated routes to Caddy.
- **Verified live through Caddy** (internal TLS): admin SPA served at `admin.localhost`
  (`<title>Astrodock Admin</title>`), `/admin/login` proxied → returns a JWT, `/webhooks/github`
  proxied → control plane.
- **Provisioners verified live**: applying an internal-everything app created the internal
  Postgres DB `app_demo` in the bundled PG, created the SeaweedFS bucket `astrodock` (S3
  ListBuckets confirms), and generated a `demo.localhost` block in Caddy's active config.
- Fixed during bring-up: Caddy admin API 403 — its `origins` must be scheme-qualified
  (`http://caddy:2019`) and the control plane sends a matching `Origin` header.
- 📦 **Still unverified-in-sandbox:** the actual deploy *worker* (clone a real GitHub repo →
  build → PM2/Docker run → health) needs a GitHub PAT + repo. Gate/trigger logic is tested; the
  build/run steps are read-reviewed. This is the one remaining thing to smoke-test with a real repo.

### Stage 7 — admin UI ✅/⚠️ (delegated to a subagent)
- De-brand + adapt to the new API contract + a new Tokens page, delegated to a subagent with the
  exact endpoint/shape spec; gated on a clean `vite build`. (See the Stage 7 commit for the
  verified build result.) Browser behavior not exercised here.

### Stage 8 — starter template + agent docs ✅
- `examples/starter-app` (frontend+server, platform login, emits AGENTS.md+CLAUDE.md), root
  `AGENTS.md`, `docs/building-apps.md`. Starter server syntax-checked; frontend is a standard
  Vite/React build (low risk).

### Stage 9 — repo essentials ✅
- `README.md`, `LICENSE` (MIT), `SECURITY.md` (threat model + v1 gaps), `CONTRIBUTING.md`,
  `docs/deploying.md` (host-agnostic), `scripts/backup.sh`, `.github/workflows/ci.yml`.
- Removed obsolete SV legacy guides (`docs/legacy/`) and the old VPS bootstrap script.
- Code/config grep-clean of `seniorverse` / `@sv` / `SV Platform` / `sv_token` (the planning
  docs `OPEN_SOURCE.md`/`BUILD_PLAN.md`/`CLAUDE.md` retain SV references narrating the fork — intentional).

## What to verify on a real Docker host (the remaining unknowns)
1. `cp .env.example .env`, fill secrets, `docker compose up -d` → all 4 services healthy.
2. Admin UI loads at `admin.<domain>`; login works; create a token.
3. `astrodock apply` + `deploy:watch` a real Node app from GitHub → PM2 process + Caddy routing + HTTPS.
4. A `runtime:docker` app → sibling container + whole-subdomain proxy.
5. Internal storage: confirm SeaweedFS bucket creation + an app reading `ASTRODOCK_STORAGE_*`.
6. GitHub webhook auto-deploy on push.

---

## Hardening pass (post-review) ✅

After a critical self-review surfaced 13 flaws, all 13 were fixed and (almost all) verified live
on the full Docker stack. Summary:

| # | Flaw | Fix | Verified |
|---|------|-----|----------|
| 1 | Node apps not isolated (shared root container, readable secrets) | per-app non-root OS user, 600-perm env files, PM2 `uid` | ✅ live (`whoami`=tsapp_e2e) |
| 2 | Internal storage = shared key, fake prefix isolation | per-app bucket + scoped SeaweedFS S3 key; shared-key fallback | ✅ live (cross-bucket = AccessDenied) |
| 3 | Internal DBs let `PUBLIC` connect | REVOKE CONNECT FROM PUBLIC on app DBs + control-plane DB | ✅ live (probe role denied) |
| 4 | Secrets plaintext at rest | AES-256-GCM (`ASTRODOCK_SECRET_KEY`); transparent decrypt | ✅ live (`v1:` blobs; verify works) |
| 5 | PM2 apps lost on platform restart | PM2_HOME on a volume + `pm2 resurrect` on boot | ✅ live (app back `online` after restart) |
| 6 | No deploy concurrency lock | DB partial-unique index → one active deploy/app | ✅ integration test |
| 7 | Orphaned resources + racy ports | `?purge=true` drops DB/role/storage; advisory-lock atomic port assign | ✅ integration |
| 8 | Caddy push best-effort, no recovery | retry w/ backoff + periodic reconciler | ✅ (routing healed live) |
| 9 | Runner merged into api (blast radius) | separate runner container (socket + PAT + PM2); api holds neither | ✅ live (api: no socket, blank PAT) |
| 10 | Health state in-memory (lost on restart) | persisted to `app_health`; migration checksums | ✅ live (api reads runner-written health) |
| 11 | Coarse token authz | per-app token scoping (`app_scope`) enforced via `router.param` | ✅ integration |
| 12 | GitHub-only deploy | `astrodock deploy --local` (tar upload → runner extract) | ✅ live |
| 13 | Core deploy loop unverified | local deploy → build → run → health → serve, via the split runner | ✅ live end-to-end |

Tests after the pass: **15 control-plane integration + 6 unit + 7 CLI** (the integration/CLI
suites now start an in-process runner, exercising the api↔runner split). Remaining known
limitations are documented in `SECURITY.md` (runner is the trust boundary; no multi-admin RBAC).

---

## Phase 6 — production hardening (Stages 10–16) ✅

All seven stages are implemented and committed. The pattern throughout: **record an event,
then optionally route it** — alerts, access logs, and the audit trail all hang off the one
spine rather than being three systems.

### Stage 10 — event & settings spine ✅
`events` table + `emitEvent()` (record a row, deliver any attached notification); existing
health down/recovery alerts rewired through it. `platform_settings` + a settings accessor
(env default → DB override) and `/admin/settings` exposing operational settings, masked infra
diagnostics, and readiness checks.

### Stage 11 — notification routing & channels ✅
`notification_rules` + `notification_deliveries` (send log, dedup/rate-limit generalising the
old `alertSent` latch). Channels: email + generic outbound webhook. New emit sites: deploy
started/succeeded/failed, pages published/deleted, auth anomaly, audit, system.

### Stage 12 — settings & notifications UI ✅
Global Settings nav: Notifications · Email · Logging & Retention · Feature flags · read-only
Diagnostics + readiness banner. Secret-typed settings reuse the AES-GCM at-rest path.

### Stage 13 — logging ✅
`page_views` (per request, IP per the retention knob) with views-over-time + referrers;
per-app Caddy access logs surfaced (status histogram + recent requests); per-app runtime log
tail via the runner; audit log surfaced in Activity.

### Stage 14 — durability: backups & disk ✅
Runner executes `pg_dumpall` against the bundled Postgres, gzipped to a backups volume on a
configurable interval (default 24h, keep 7). Each run records a row and emits
`backup.succeeded` / `backup.failed`, so a failed backup alerts (deduped). Manual "Back up
now". Disk checked every 5m → `system.disk_high` past a configurable threshold (default 85%).

### Stage 15 — deploy safety & platform self-health ✅
Rollback: the worker can check out a specific `targetCommit`; `POST /apps/:slug/rollback`
finds the last good build and redeploys it. Build timeouts made configurable. A control-plane
checker probes DB / object store / runner reachability + admin-host TLS cert every 2m,
emitting `system.dependency_down`/`_up` and `system.cert_expiring` (≤14d, deduped).
📦 The cert probe and dependency probes need a live stack; logic is unit-load-verified.

### Stage 16 — custom domains & DNS ✅
`custom_domains`: add a hostname → the UI shows the exact DNS records (A to the server IP +
TXT challenge) → "Verify" resolves the TXT and activates. Active domains get a Caddy site
block mirroring the app's routing; with `tlsMode=auto`, on-demand TLS is gated by a public
`/_caddy/ask` endpoint that authorises only registered+active hostnames. **With zero custom
domains the Caddyfile is byte-for-byte unchanged** (safe default). Canonical redirects
(`redirectToCanonical` → 301 preserving path + query). Health loop re-resolves active domains
every 30m, emitting `domain.dns_drift`. Reserved-subdomain fix pulled forward — apps can no
longer claim `admin`/`pages`/the configured platform subdomains, and subdomains must be valid
DNS labels.
📦 DNS resolution + on-demand TLS need a live stack; generation logic and wiring verified here.

---

## Admin UI — "Orbital Mission Control" redesign ✅

Six commits, built screen by screen from self-contained HTML prototypes (`ea0c29c`) that
served as the design spec.

- **Foundation** (`348851e`): `App.css` rewritten as a CSS-variable design system; dark
  (default) + light are two token sets switched via `<html data-theme>`. Saira + IBM Plex
  Mono, flash-free theme init. Orbital logomark replaced the leftover "TS" mark.
- **Overview** (`95e4b42`): new landing page after login — system-state hero (calm green /
  loud red), a "Needs attention" block prominent only when something is wrong, telemetry,
  live activity feed, platform-dependency grid, polling every 15s. Nav regrouped into
  Operate / Network & access / Observe; "Tokens" → "Access keys".
- **Apps + Domains** (`4630875`): Apps rebuilt as status-driven cards (problems sorted
  first); new global Domains roll-up page + `GET /admin/domains`.
- **Settings + Health** (`dc73b93`): Settings rebuilt to field rows with readiness cards and
  a sticky save bar; Health became the detailed metrics page with live sparklines
  (accumulated client-side — **no faked history**). Fixed `.data-table` corner clipping.
- **App-manage page** (`6bc056f`, `c596964`): every tab brought to the same design +
  explanation bar — Deploys (status LED, trigger attribution, expand-to-log), Variables
  (split "Your variables" vs "Provided by Astrodock"), Logs, Terminal (explicit danger note),
  and the Custom-domains tab reworked to match the Domains roll-up idiom.

Not-yet-backed pieces are deliberately marked "soon" in the UI rather than faked: in-UI email
key, off-box log forwarding, backup download/restore, lockdown, danger zone.

---

## Rename: Toolstead → Astrodock ✅ (2026-07-26)

The working name changed and the folder was renamed `Toolstead` → `Astrodock`. The repo
content had already been migrated (package name, compose project name, all source) — this was
the folder and the last stragglers. Compose is unaffected because `docker-compose.yml` pins
`name: astrodock`, so volumes were never keyed to the directory name.

### Config/env fix pass — the de-brand did not reach gitignored files ⚠️→✅

Standing up the host-side dev path after the rename surfaced four related defects. All four
are fixed; **the root cause in three of them was that the de-brand swept tracked files only,
so gitignored config kept the dead `TOOLSTEAD_` prefix and silently stopped being read.**

| # | Defect | Fix |
|---|--------|-----|
| 1 | `apps/control-plane/.env` was a stale Toolstead-era file — all 20 vars `TOOLSTEAD_*`, ignored by `ASTRODOCK_*` code | renamed to `.env.toolstead-era.disabled` (preserved, still gitignored) |
| 2 | Root `.env` never loaded in host-side dev: `config.js` called `dotenv.config()` with no path, and npm workspaces set cwd to the *package* dir, so it looked for `apps/control-plane/.env` and found nothing | `dotenv.config({ path: resolve(__dirname, '../../../.env') })` — cwd-independent. Docker unaffected (compose `env_file` already populates the env; dotenv never overrides) |
| 3 | `ASTRODOCK_ENV` absent from `.env.example`, so it defaulted to `production`, where the CORS matcher rejects `http://localhost:<port>`. Surfaced only as a generic **500 "Not allowed by CORS"** with no hint at the cause | added to `.env.example` with an explanation; `dev` script now sets `ASTRODOCK_ENV=development` so `npm run dev:api` is correct by construction |
| 4 | `config.js` fell back to `PG_PASSWORD \|\| 'astrodock'` — a real deploy missing the var would connect with a guessable credential instead of failing loudly (`ADMIN_JWT_SECRET` correctly fatals; this silently did not) | startup guard: refuses to boot when `env === 'production'` and `ASTRODOCK_PG_PASSWORD` is unset. Dev default retained so a laptop still boots |

**Verified:** ✅ plain `npm run dev:api` now boots on the root `.env` (previously died on a
missing JWT secret) and reports `env=development`; CORS preflight from the Vite origin returns
204 with a matching `Access-Control-Allow-Origin`; admin login returns a JWT **with an `Origin`
header set** — the earlier check missed this because node's `fetch` sends no `Origin`, so it
passed while the browser was rejected. Production guard exercised directly (FATAL as intended).
30 unit tests still pass (schema 14, control-plane 6+6, cli 4).

### Host-side dev quickstart (what actually works)

The compose stack publishes only Caddy's 80/443, so host-side dev needs its own Postgres:

```bash
docker run -d --name astrodock-pg -p 5432:5432 \
  -e POSTGRES_USER=astrodock -e POSTGRES_PASSWORD=<ASTRODOCK_PG_PASSWORD> \
  -e POSTGRES_DB=astrodock postgres:16-alpine
npm run migrate && npm run seed     # seed needs ADMIN_EMAIL/PASSWORD set in the root .env
npm run dev:api                     # :3100, development mode
npm run dev:admin                   # :5173 (use `-- --port N` if 5173 is taken)
python3 -m http.server 8080 --directory docs   # the public docs site (pure static)
```

Caveat: no Caddy and no object store on this path, so the API logs `[caddy] reload error` on a
loop and routing/storage/domain panels are empty. Use the full compose stack to exercise those.
