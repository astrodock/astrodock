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
- `@toolstead/auth-client` — rebranded, config-from-env defaults, `.d.ts` added. ✅
- `@toolstead/schema` — `app.json` JSON Schema (Draft 2020-12) + validator + reserved-env
  catalog + required-var helper. **11/11 unit tests pass.** ✅
- `@toolstead/cli`, `@toolstead/control-plane` package manifests written (deps installed).
- Deep de-brand of the control-plane source and admin UI happens inside their rewrite stages
  (3 and 7) since those files are being rewritten anyway. Final tree is grep-clean of
  `seniorverse` / `@sv` / "SV Platform".

### Stage 3 — Mongo → Postgres (Drizzle) ✅
- Drizzle schema + plain-SQL migration + minimal migration runner (verified against local PG 16).
- All routes ported off mongoose; new auth middleware (admin JWT OR scoped token).
- **12 integration tests pass** (health, admin login/authz, /verify success+failures, manifest
  apply incl. real internal-DB provisioning, rotate-secret, user CRUD+access, deploy gate, token authz).

### Stage 4 — env model + app.json + provisioning ✅
- Reserved `TOOLSTEAD_*` computation + required-var gate (6 unit tests). Internal Postgres
  provisioner verified end-to-end (creates role+db). Internal storage provisioner + Caddy
  generator written; Caddy generation unit-tested.

### Stage 5 — runner (hybrid compute) ⚠️ partially verified
- Deploy trigger + gate verified (integration). Node-buildpack (PM2) deploy path and Docker
  (sibling-container) deploy path are 📦 **unverified-in-sandbox** — they need git + PM2 + the
  Docker socket inside the running stack. Code complete + read-reviewed.

### Stage 6 — CLI + scoped tokens ✅
- `@toolstead/cli` drives the live control plane. **7 CLI integration tests pass** (apply with
  real provisioning, apps, set-secret, status, deploy gate, app.json validation).

### Stage 2 — docker compose stack ⚠️ config verified, image build pending
- `docker compose config` validates. Multi-stage Dockerfile, Caddy bootstrap, entrypoint, root
  `.env.example` written. 📦 Full `docker compose build` + `up` (Caddy routing, SeaweedFS, the
  runner deploy paths) **unverified-in-sandbox** — needs a real Docker host. This is the #1 thing
  to smoke-test on a box.

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
3. `toolstead apply` + `deploy:watch` a real Node app from GitHub → PM2 process + Caddy routing + HTTPS.
4. A `runtime:docker` app → sibling container + whole-subdomain proxy.
5. Internal storage: confirm SeaweedFS bucket creation + an app reading `TOOLSTEAD_STORAGE_*`.
6. GitHub webhook auto-deploy on push.
