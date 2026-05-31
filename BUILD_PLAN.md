# Toolstead — Build Plan

Instructions for a fresh Claude Code session picking up Toolstead cold. This combines the
**de-brand** (Phase 1) and the **scaffold/rebuild** (Phases 3 & 5) into one ordered build.

> **Before you start:** read `CLAUDE.md`, then `OPEN_SOURCE.md` (roadmap + decisions +
> de-brand inventory), then `docs/platform-spec.html` (the technical contract for `app.json`,
> the env model, the runner, and deploy flows). Don't duplicate the spec — implement to it.

## Working agreements
- **Don't touch `../SV - Sandbox`** (the original, still in production).
- This is a **rebuild**: port the forked SV code as *reference*. Rewrite freely toward the spec.
- Work **stage by stage**; finish a stage's "Done when" before moving on. **Commit per stage.**
- Keep secrets out of git (`.gitignore` already covers `.env*` / `setup.conf`). Commit only `*.example`.
- Commit message trailer (required): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- When you hit an **open decision** (see bottom), surface it to the user rather than guessing.
- Prefer small, verifiable steps. Run things; don't assume they work.

---

## Stage 0 — Initialize the repo  ⬅ START HERE
1. Confirm cwd is the Toolstead folder and `.gitignore` exists (it does).
2. `git init` and set the default branch to `main` (`git branch -m main`).
3. **Secret sanity check before the first commit:** run `git status` and confirm NO `.env`,
   `setup.conf`, `node_modules/`, or `dist/` appear as tracked/untracked-to-be-added. Only
   `.env.example` / `setup.conf.example` should be present. (A scan should already pass — verify.)
4. Baseline commit: `git add -A && git commit` with message
   `chore: initial fork from internal tool — Phase 0 complete` + the Co-Authored-By trailer.
5. Do **not** add a remote or push (not authorized yet).

**Done when:** `git log` shows the baseline commit and `git status` is clean with no secrets tracked.

---

## Stage 1 — Skeleton + de-brand (do these together)
Establish the monorepo and strip all SV branding in one pass, since files move anyway.

1. **Target layout** (rename from the forked structure):
   ```
   package.json            ← new: npm workspaces root (dev/build scripts across packages)
   docker-compose.yml      ← Stage 2
   .env.example            ← platform stack config (base domain, admin seed, PG creds, …)
   apps/
     control-plane/        ← was auth-api  (Express API + provisioners + deploy orchestration)
     admin/                ← was auth-admin (React admin UI)
   packages/
     auth-client/          ← @toolstead/auth-client (keep; rename scope)
     cli/                  ← new: @toolstead/cli   (Stage 6)
     schema/               ← new: shared app.json JSON Schema (Stage 4)
   examples/starter-app/   ← Stage 8
   docs/                   ← platform-spec.html (here) + building-apps.md (Stage 8)
   AGENTS.md, README.md, LICENSE   ← Stage 8/9
   ```
2. **De-brand pass** — use `OPEN_SOURCE.md` "Phase 1" as the checklist (it has file:line refs,
   though paths shift after the rename — apply against the moved files). Replace:
   - `@sv/*` package names → `@toolstead/*`.
   - `seniorverse.dev` / `seniorverse.com` hardcoded defaults → config-driven (`BASE_DOMAIN`, etc.); no SV fallback.
   - The CORS regex in the control-plane server (was `*.seniorverse.dev`) → config-driven allowed-origin.
   - Email "from", alert address, seed admin email, Spaces bucket default → env-driven.
   - "SV Platform" / "SV" branding in the admin UI + email subjects → "Toolstead".
   - Remove the stale SV doc files (`sv-platform-architecture.md`, and rewrite `deployment-guide.md` /
     `app-auth-guide.md` later in Stage 9) — or move under `docs/legacy/` for reference.
3. Establish the **`TOOLSTEAD_` env prefix** convention (full catalog in the spec, §4).

**Done when:** no `seniorverse`/`@sv`/`SV Platform` strings remain in code/config (grep clean),
packages are `@toolstead/*`, and the workspace root builds.

---

## Stage 2 — Bundled infra: the `docker compose` stack
Implement the topology from the spec (§2).

1. `docker-compose.yml` services: `postgres`, `objectstore` (SeaweedFS, S3-compatible),
   `caddy`, `api` (control-plane), and a `runner` (Node + PM2 + git + Docker CLI; mounts the
   Docker socket). One bridge network; volumes `pgdata`, `objectdata`, `static`, `apps`, `repos`.
   *(Runner may start merged into `api` and split out later — see Stage 5.)*
2. `.env.example` for the stack itself (platform config + admin seed + generated secrets).
3. Caddy config (static + `/api/*` proxy; whole-proxy for Docker apps — Stage 5 generates per-app blocks).

**Done when:** `docker compose up` boots the stack (api can be a stub) and Caddy serves a health page.

---

## Stage 3 — Control-plane store refactor (Mongo → Postgres)
This is the heart of "zero external deps." (Recommended layer: **Drizzle** — SQL-first, light
migrations; Prisma is fine too. Confirm choice with the user if unsure.)

1. Recreate the models as Postgres tables + migrations: `users`, `apps`, `deployments`,
   `auth_logs`, and a new `api_tokens` (hashed scoped tokens).
2. Port the routes off `mongoose` to the new data layer, preserving behavior: `/verify`,
   admin auth, user CRUD, app CRUD, activity, health, account, webhooks.
3. Seed the admin user from env on first boot.

**Done when:** the control plane boots against bundled Postgres; `/health`, admin login, and
`/verify` work; no `mongoose` remains.

---

## Stage 4 — Env model + `app.json` + resource provisioning
Implement to spec §3 (manifest), §4 (env model), §5 (provisioning).

1. `app.json` JSON Schema in `packages/schema`; validate in the API + CLI.
2. Reserved `TOOLSTEAD_*` env catalog + injection logic computed from the resource modes.
3. **Provisioners:** internal DB (create Postgres db/role → `TOOLSTEAD_DATABASE_URL`); internal
   storage (SeaweedFS bucket/prefix + scoped key → `TOOLSTEAD_STORAGE_*`); external passthrough; none.
4. **Required-variable deploy gate** (block deploy until all required vars + external-resource creds are set).

**Done when:** creating an app provisions its resources and computes the injected env set;
a missing required var blocks deploy with a clear message.

---

## Stage 5 — Runner (Hybrid compute)
Port the forked deploy-worker; branch on `runtime.type` (spec §6).

1. **Node buildpack:** clone/pull → detect `app/`+`server/` → build → static to `static` vol →
   PM2 process bound to `TOOLSTEAD_PORT`. Caddy: static + `/api/*` → runner.
2. **Dockerfile:** `docker build` → run sibling container on the stack network → Caddy whole-proxies the subdomain.
3. Deploy records + streamed logs; health probe unified across both paths.

**Done when:** a sample Node app and a sample Dockerfile app each deploy end-to-end and serve over HTTPS.

---

## Stage 6 — CLI + scoped tokens (the agent surface)
1. `packages/cli` (`toolstead`, alias `stead`): `apply` (manifest-driven create/connect/provision),
   `deploy`, `status`, `logs`, `deploy:watch`, `set-secret`. Reads `TOOLSTEAD_URL` + `TOOLSTEAD_TOKEN`.
2. `api_tokens` auth path in the control plane (accept admin JWT **or** a scoped token; tokens exclude user management).

**Done when:** from an app repo, `toolstead apply && toolstead deploy && toolstead deploy:watch` runs the full loop.

---

## Stage 7 — Admin UI de-brand + adapt
Rebrand `apps/admin`, adapt the API client to the new endpoints, add UI for resource modes,
env/secret management, and token management.

**Done when:** the admin UI manages apps/users/tokens/resources against the new control plane.

---

## Stage 8 — Starter template + agent docs (the AI deploy story)
1. `examples/starter-app`: Node `app/` + `server/`, wired to `@toolstead/auth-client`, with a
   ready `app.json`, that **emits `AGENTS.md` + `CLAUDE.md` into new apps**.
2. Root **`AGENTS.md`** + `docs/building-apps.md`: the precise agent contract derived from the
   spec (layout, routing, the `TOOLSTEAD_*` env vars to read, auth flow, deploy lifecycle).
   This is the "plenty of documentation for the AI on how to deploy" deliverable.

**Done when:** following `AGENTS.md` alone, an agent can scaffold from the starter and deploy via the CLI.

---

## Stage 9 — Repo essentials
- `README.md` — lead with the wedge: "auth + users included, and an AI can build & launch it on your own box."
- `LICENSE` (open decision below), `CONTRIBUTING.md`.
- Rewrite/De-DigitalOcean the old guides under `docs/`; "any VPS / any box," external services as upgrades.
- Optional: CI + smoke tests for `/verify` and the CLI.

**Done when:** a newcomer can read the README, `docker compose up`, and deploy the starter app.

---

## Open decisions — surface to the user when you reach them
- **License:** MIT (recommended) vs Apache-2.0.
- **Internal backups:** local-only vs optional off-box to an external object store.
- **Postgres layer:** Drizzle (recommended) vs Prisma — confirm before Stage 3.
- **Custom domains** per app (Caddy on-demand TLS) — additive, likely post-v1.
- **Non-GitHub deploy** (CLI push of a local build) — post-v1.
- **Terminal endpoint:** keep, but gate behind an `ENABLE_TERMINAL` env flag (recommended).
- Whether to revisit the **name** (Toolstead is a working placeholder).
