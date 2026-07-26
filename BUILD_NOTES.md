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

---

## Stage 17 — Zero-touch install ✅ (code) / 📦 (end-to-end)

The install was seven steps and ~25 minutes; three of those steps were ours. Working backwards
from "why", all three came from **shipping source instead of images** — the box needed git, a
source tree, and a build toolchain — plus one constraint: the **base domain was env-only**, so it
had to be chosen before the first boot, before any UI could ask for it.

The unlock was that the pieces to fix the second half already existed. The bootstrap `Caddyfile`
already served `:80` before any config; the control plane already **hot-pushes a whole new
Caddyfile at runtime**; on-demand TLS + the `/_caddy/ask` gate were already built for custom
domains. Setting the domain at runtime was re-use, not new capability.

### What changed

| Area | Change |
|---|---|
| Images | `docker-compose.yml` pulls `${ASTRODOCK_IMAGE:-ghcr.io/astrodock/astrodock}:${ASTRODOCK_VERSION:-latest}`; **`docker-compose.build.yml`** is an 8-line overlay restoring `build:` (nothing else, so there's no second copy of the service definitions to drift) |
| Release | `.github/workflows/release.yml` — buildx amd64+**arm64** (the cheap droplet tier is Ampere; single-arch would have silently excluded it) → GHCR on a `v*` tag, then a smoke test that both roles load inside the published image |
| Install | **`scripts/install.sh`** for `curl \| sh`: preflights docker, fetches compose + env template, generates secrets, pulls, ups, prints the address. Detects the server IP from `ip route get`, not an external service |
| Secrets | `scripts/setup.sh` **asks nothing now**. Also switched its staging file from `mktemp` to `$OUT.tmp.$$` — same filesystem, so the `mv` is a real atomic rename (a half-written `.env` full of secrets would be nasty) |
| Domainless boot | `ASTRODOCK_BASE_DOMAIN=''` ⇒ unconfigured. `generateCaddyfile` short-circuits to a `:80` wizard site with `auto_https off`. `config.isConfigured()` / `applyRuntimeDomain()` |
| Runtime domain | Third settings tier `BOOTSTRAP_REGISTRY` (`platform.base_domain`/`.tls_mode`/`.acme_email`), applied over env at boot in **both** roles. The runner re-reads every 60s since it can't be notified |
| Setup API | `src/routes/setup.js` — `/status`, `/claim` (setup-token-gated), `/check-dns`, `/domain` |
| Wizard UI | `apps/admin/src/pages/SetupPage.jsx` + `.setup-*` styles; `App.jsx` asks `/setup/status` before choosing what to render |
| Firewall | `src/runner/exposure.js` + a readiness card |

### Decisions worth remembering

- **The setup token is in-memory, printed at boot, and cleared once an admin exists.** It's a
  proof-of-log-access credential, not a secret worth persisting; a restart reprinting a fresh one
  is the correct behaviour, not a bug.
- **Claim the admin *before* the domain.** That way the domain step is protected by ordinary admin
  auth and the token is used exactly once, for exactly one thing.
- **The A-record value comes from `window.location.hostname`.** The operator reached the wizard by
  typing the server's IP, so the browser already knows it — no "what is my IP" service, no
  outbound call, no new dependency.
- **CORS opens while unconfigured and closes on setup.** A same-origin POST still carries an
  `Origin`, and the server's IP can't be known in advance, so a strict matcher would block the very
  flow that sets the domain. Nothing there is protected by CORS anyway — `/claim` is token-gated.
- **The firewall is reported, not managed** — reasoning recorded in `runner/exposure.js`: Docker's
  iptables rules sit ahead of `ufw`'s chains, so a naive implementation would claim protection it
  wasn't providing, and a bug would lock the operator out through the only door they have.

### Verified ✅
- **37 unit tests pass** (schema 14, control-plane 13+6, cli 4) — up from 30. New coverage: setup-mode
  Caddyfile generation, runtime domain re-keying, the CORS open/close transition, the empty-domain
  Pages-host trap, and the `docker ps` port parser (IPv6 `[::]` duplicates, loopback binds,
  container-internal ports, host≠container port).
- `scripts/setup.sh` exercised in a temp tree across all three paths (default / `--domain` /
  `--local`): zero prompts, `.env` at 600, no leftover temp file.
- `scripts/install.sh` run end-to-end against a local file source with a stubbed `docker` — fetch,
  secret generation, version pinning, `pull`/`up`, and the re-run "already installed" guard.
- Admin SPA builds clean (`vite build`); control plane, runner, and all changed modules load.

### Not verified 📦 — needs a real Docker host
1. **The whole flow end to end.** Boot unconfigured → wizard at `http://<ip>` → claim → domain →
   Caddy hot-reload → HTTPS at the new host. Every part is unit-tested or read-reviewed; the
   sequence has never run.
2. **Caddy accepting the setup-mode Caddyfile.** Generation is tested; Caddy has not parsed it.
3. **`/setup/check-dns`** against real DNS.
4. **The exposure check** — `docker ps` output is parsed by tested code, but the runner endpoint
   has not been called against a live socket.
5. **The release workflow.** Never run: it needs a repository and a tag. The compose and workflow
   YAML could not even be lint-parsed here (no yaml module available, docker socket blocked), so
   treat both as unproven syntax.
6. **The published-image install path does not work yet** — `ghcr.io/astrodock/astrodock` and
   `get.astrodock.dev` don't exist until the repo is published and a release is tagged. Both are
   parameterised (`ASTRODOCK_IMAGE`, `ASTRODOCK_RAW_BASE`), and the build-from-source path works
   today, but the README's headline command is *aspirational until then*.

### Fixed in passing
`App.jsx`'s sidebar footer rendered a hardcoded `localhost` as the system-chip subtitle
(pre-existing, but newly wrong now that the domain is chosen at runtime). It reads the effective
base domain from `/setup/status`, which `App.jsx` already fetches.
