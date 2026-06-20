# Astrodock — Build Plan

Instructions for a fresh Claude Code session picking up Astrodock cold. This combines the
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
1. Confirm cwd is the Astrodock folder and `.gitignore` exists (it does).
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
     auth-client/          ← @astrodock/auth-client (keep; rename scope)
     cli/                  ← new: @astrodock/cli   (Stage 6)
     schema/               ← new: shared app.json JSON Schema (Stage 4)
   examples/starter-app/   ← Stage 8
   docs/                   ← platform-spec.html (here) + building-apps.md (Stage 8)
   AGENTS.md, README.md, LICENSE   ← Stage 8/9
   ```
2. **De-brand pass** — use `OPEN_SOURCE.md` "Phase 1" as the checklist (it has file:line refs,
   though paths shift after the rename — apply against the moved files). Replace:
   - `@sv/*` package names → `@astrodock/*`.
   - `seniorverse.dev` / `seniorverse.com` hardcoded defaults → config-driven (`BASE_DOMAIN`, etc.); no SV fallback.
   - The CORS regex in the control-plane server (was `*.seniorverse.dev`) → config-driven allowed-origin.
   - Email "from", alert address, seed admin email, Spaces bucket default → env-driven.
   - "SV Platform" / "SV" branding in the admin UI + email subjects → "Astrodock".
   - Remove the stale SV doc files (`sv-platform-architecture.md`, and rewrite `deployment-guide.md` /
     `app-auth-guide.md` later in Stage 9) — or move under `docs/legacy/` for reference.
3. Establish the **`ASTRODOCK_` env prefix** convention (full catalog in the spec, §4).

**Done when:** no `seniorverse`/`@sv`/`SV Platform` strings remain in code/config (grep clean),
packages are `@astrodock/*`, and the workspace root builds.

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
2. Reserved `ASTRODOCK_*` env catalog + injection logic computed from the resource modes.
3. **Provisioners:** internal DB (create Postgres db/role → `ASTRODOCK_DATABASE_URL`); internal
   storage (SeaweedFS bucket/prefix + scoped key → `ASTRODOCK_STORAGE_*`); external passthrough; none.
4. **Required-variable deploy gate** (block deploy until all required vars + external-resource creds are set).

**Done when:** creating an app provisions its resources and computes the injected env set;
a missing required var blocks deploy with a clear message.

---

## Stage 5 — Runner (Hybrid compute)
Port the forked deploy-worker; branch on `runtime.type` (spec §6).

1. **Node buildpack:** clone/pull → detect `app/`+`server/` → build → static to `static` vol →
   PM2 process bound to `ASTRODOCK_PORT`. Caddy: static + `/api/*` → runner.
2. **Dockerfile:** `docker build` → run sibling container on the stack network → Caddy whole-proxies the subdomain.
3. Deploy records + streamed logs; health probe unified across both paths.

**Done when:** a sample Node app and a sample Dockerfile app each deploy end-to-end and serve over HTTPS.

---

## Stage 6 — CLI + scoped tokens (the agent surface)
1. `packages/cli` (`astrodock`, alias `adock`): `apply` (manifest-driven create/connect/provision),
   `deploy`, `status`, `logs`, `deploy:watch`, `set-secret`. Reads `ASTRODOCK_URL` + `ASTRODOCK_TOKEN`.
2. `api_tokens` auth path in the control plane (accept admin JWT **or** a scoped token; tokens exclude user management).

**Done when:** from an app repo, `astrodock apply && astrodock deploy && astrodock deploy:watch` runs the full loop.

---

## Stage 7 — Admin UI de-brand + adapt
Rebrand `apps/admin`, adapt the API client to the new endpoints, add UI for resource modes,
env/secret management, and token management.

**Done when:** the admin UI manages apps/users/tokens/resources against the new control plane.

---

## Stage 8 — Starter template + agent docs (the AI deploy story)
1. `examples/starter-app`: Node `app/` + `server/`, wired to `@astrodock/auth-client`, with a
   ready `app.json`, that **emits `AGENTS.md` + `CLAUDE.md` into new apps**.
2. Root **`AGENTS.md`** + `docs/building-apps.md`: the precise agent contract derived from the
   spec (layout, routing, the `ASTRODOCK_*` env vars to read, auth flow, deploy lifecycle).
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

## Phase 6 — Production hardening (single-host operator)

Stages 0–9 got the platform standing up and deploying apps. Phase 6 makes a **single
trusted operator's box** production-ready: observability, alerting, in-UI configuration,
durability, and deploy safety. **Scope guard:** anything that only matters with multiple
mutually-distrusting operators/customers is **out** — it lives in `MULTI_TENANT.md`. The
audit log stays here (one operator still wants a change history); the multi-admin RBAC layer
on top of it does not.

**Architectural keystone:** items 2/3/4 below are one primitive — *record an event, then
optionally route it*. Build the event/audit spine first; alerts, access logs, and the audit
trail all hang off it instead of being three systems.

### Pinned decisions (defaults for this phase)
- **Settings precedence:** infra/bootstrap config (PG, secret key, domain, ports, object-store
  creds) stays **env-only**, surfaced **read-only** as Diagnostics. Operational settings (alert
  routing, retention, thresholds, email-from, feature flags) take env as default + a **DB
  override**, applied live where safe.
- **Page-view IP retention:** store the full IP + prune on the retention window by default;
  knob `ASTRODOCK_PAGE_LOG_IP=full|truncated|off` (operator/GDPR choice).
- **v1 alert channels:** email (exists) + a generic **outbound webhook** (JSON; Slack/Discord
  compatible). Native chat formatting is later.
- **Severity levels:** `info | warning | critical`.

### Stage 10 — Event & settings spine (keystone)
- `events` table (audit + system events) and `emitEvent()` that records a row and delivers any
  attached notification. Rewire the existing health down/recovery alerts through it
  (behavior-preserving).
- `platform_settings` table + a settings accessor (env default → DB override) and an admin-only
  `/admin/settings` API exposing operational settings, read-only infra **diagnostics** (secrets
  masked), and **readiness** checks (SECRET_KEY set? alert email set? email provider set?).
- **Done when:** an app going down still emails *and* writes an `events` row; auth-log retention
  is read from settings (default 90); `GET /admin/settings` returns settings + diagnostics +
  readiness, and `PATCH` records an audit event. *(Backend in place; UI is Stage 12.)*

### Stage 11 — Notification routing & channels
- `notification_rules` (per event/category → channels, targets, min severity, app scope) +
  `notification_deliveries` (send log; dedup/rate-limit — generalize the health `alertSent`
  latch). Channels: email + outbound webhook. A "send test alert" action.
- New emit sites: **deploy** started/succeeded/**failed** (deploy-worker emits nothing today),
  **pages** published/deleted, **auth anomaly** (failed-`/verify` bursts), **audit** (token/user/
  settings changes), **system** (disk/mem/load high — `getServerMetrics` already computes them).
- **Done when:** a deploy failure and an app-down both notify per configured rules across
  email + webhook, deduped; the test action delivers on each enabled channel.

### Stage 12 — Settings & notifications UI
- Global **Settings** nav (alongside Users/Apps/Tokens/Activity/Health): Notifications · Email ·
  Logging & Retention · Feature flags · Diagnostics (read-only) + the readiness banner.
- **Done when:** an operator can edit alert routing + retention and see effective config without
  SSH; secret-typed settings reuse the AES-GCM at-rest path.

### Stage 13 — Logging: page access, app access, audit surfacing
- `page_views` table (per request: ts, IP per the retention knob, UA, referrer, path, userId,
  status) written in the Pages public middleware; keep the aggregate counter for cheap display;
  prune on the retention window. Views-over-time / referrers / per-file hits.
- Surface **Caddy access logs** for deployed apps (JSON log to a mounted volume): tail + per-app
  request-rate / status-code breakdown — today end-user app traffic is a blind spot.
- Per-app **live runtime logs** tail (PM2 / `docker logs`) via the runner; extend CLI `logs`.
- Audit log surfaced in the Activity UI; cap `deployments.log` size/retention.
- **Done when:** page views show source/referrer over time, deployed-app traffic is visible, and
  admin actions appear in an audit trail.

### Stage 14 — Durability: backups & disk/quota
- Scheduled `pg_dump` + object-store snapshots; last-run status; **alert on backup failure**;
  optional off-box copy to an external S3 (the one place an external dep earns its keep).
- Disk usage per consumer (apps/builds/pages/logs/objects); caps; threshold alerts; prune old
  builds/logs/orphaned objects. (Single-box disk-full is the classic single-VPS outage.)
- **Done when:** a restorable backup runs on schedule, and a failed backup or low-disk condition
  alerts.

### Stage 15 — Deploy safety & platform self-health
- **Rollback:** "redeploy last successful build," keep last-N artifacts; build timeout.
- **Platform self-health:** probe DB / object-store / runner reachability + disk and surface +
  alert (today only *apps* are probed); TLS cert-expiry alert.
- Optional operator-facing **status page** summarizing app + platform health.
- **Done when:** a bad deploy can be rolled back in one action; platform-level outages and cert
  expiry alert.

### Stage 16 — Custom domains & DNS
Today every app lives at `<subdomain>.<base-domain>` (one base domain, one wildcard DNS
record, global TLS mode). This stage lets an app (and a Page) be served at an **operator-owned
external domain**, with a guided add → verify → activate flow in the admin UI.

- **Reserved-subdomain fix (pull forward — latent bug):** app subdomains are only validated as
  `/^[a-z0-9-]+$/`, so an app can claim `admin`/`pages`/the configured admin subdomain and
  collide with a platform host in the generated Caddyfile. Block reserved names (`admin`,
  `pages`, `www`, `api`, the configured admin/pages subdomains) and reject invalid DNS labels
  (leading/trailing hyphen, label > 63). *Do this independently of the rest of the stage.*
- **Data:** `custom_domains` (id, appId, hostname, status `pending|verifying|active|failed`,
  verificationToken, isPrimary, redirectToCanonical, lastCheckedAt, createdAt). One app → many
  domains. A Page may own domains too (nullable appId / pageId).
- **Domain-management UI (the operator flow):**
  1. Operator adds a hostname (e.g. `app.example.com` or apex `example.com`) to an app.
  2. The system **shows the exact DNS records to create** — an `A`/`AAAA` to the server's public
     IP (detected/configured), plus a `TXT` verification record (`_astrodock-challenge`) — with
     copy buttons and per-record status.
  3. A **"Verify"** action resolves the records (A/AAAA points here? TXT matches?) and flips the
     domain to `active`; clear per-record pass/fail feedback on failure.
- **Verification folded into health checks:** the existing 60s health loop re-resolves active
  custom domains and watches for **DNS drift** (record no longer points here) and cert
  status/expiry, emitting `domain.dns_drift` / `domain.cert_failed` / cert-expiry events through
  the Stage 10/11 event spine. (This is the "add verification to our health checks" ask.)
- **Routing:** extend `nodeAppBlock`/`dockerAppBlock` to emit the same `handle` blocks keyed on
  each active custom host; honor `isPrimary` + `redirectToCanonical` (redirect the others, incl.
  the subdomain, to the canonical) and `www`↔apex normalization. Decide apex (base-domain root)
  handling here too.
- **TLS — pinned default: Caddy on-demand TLS.** A site block per active custom host with
  `tls { on_demand }`, plus a global `on_demand_tls { ask <url> }`; the control plane's `ask`
  endpoint authorizes issuance only for a hostname that is a *registered active* custom domain
  (prevents abuse, no pre-provisioning). DNS-01 wildcard (bundled Caddy DNS plugin) is the later
  upgrade, not v1.
- **Pages custom domains:** once the app path works, let a published Page bind its own host via
  the same on-demand mechanism.
- **Done when:** an operator can add a custom domain to an app, copy the shown DNS records, click
  Verify, and reach the app over HTTPS at that domain; the health loop flags DNS drift / cert
  problems via alerts; and no app can claim a reserved subdomain.

> **Out of scope (see `MULTI_TENANT.md`):** cross-tenant domain ownership/isolation and automated
> domain delegation per customer. Everything above is for the single operator's own domains.

---

## Open decisions — surface to the user when you reach them
- **License:** MIT (recommended) vs Apache-2.0.
- **Internal backups:** local-only vs optional off-box to an external object store.
- **Postgres layer:** Drizzle (recommended) vs Prisma — confirm before Stage 3.
- **Custom domains** per app (Caddy on-demand TLS) — additive, likely post-v1.
- **Non-GitHub deploy** (CLI push of a local build) — post-v1.
- **Terminal endpoint:** keep, but gate behind an `ENABLE_TERMINAL` env flag (recommended).
- Whether to revisit the **name** (Astrodock is a working placeholder).
