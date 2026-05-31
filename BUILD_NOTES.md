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
