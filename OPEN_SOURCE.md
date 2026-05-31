# Open-Sourcing Roadmap

A prioritized, trackable plan for turning this internal Seniorverse platform into a
public open-source project that lets others deploy, host, auth, and monitor small apps
on a single VPS.

> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Decisions locked in

- **Scope:** Ship the **whole platform** — auth + deploy + health + terminal — as one
  project. (Most powerful; matches how it's actually run. Requires honest threat-model
  docs because of the RCE-by-design surface.)
- **Scaffolding:** Add a **starter template** — an example app (frontend + server) wired
  to the auth-client, so "scaffold small apps" is literally true. (Not a full CLI generator
  for v1.)
- **Product thesis (AI-native):** the headline use case is — spend ~15 min standing up the
  platform once, then point an AI agent (Claude Code or similar) at it to build, auth, and
  **launch** small tools on the open internet. So agent-readable docs and an agent-drivable
  deploy path are first-class deliverables, not afterthoughts.
- **Agent autonomy = L2 (scoped token + CLI):** add an API token (separate from the admin
  JWT) and a thin CLI the agent runs to drive the full register → deploy → observe loop.
  MCP server is a possible later wrapper, not v1.
- **App manifest = yes (`app.json` auto-register):** each app repo carries a manifest the
  CLI applies to create/connect/provision automatically. Manifest holds declared config and
  env-var *names* only — never secret values.
- **Zero external dependencies to boot:** the platform bundles its own database and object
  storage and uses them for its own control-plane data. External managed services are an
  *upgrade*, never a prerequisite. "Deploy once and don't worry about it" is the north star.
- **Per-app resource choice (internal vs external):** at app setup, the user/agent picks —
  for **database** and for **object storage** — the platform's internal managed store (path
  of least resistance; "fine, not fantastic") or an external service (BYO connection string,
  for heavier needs). Apps read a connection string from env either way, so app code is
  identical; only the source differs. The AI presents these choices when building an app.
- **Compute = Hybrid:** Node buildpack is the zero-config default; an app may ship a
  Dockerfile for any runtime / stronger isolation.
- **Bundled engine = Postgres:** the platform bundles Postgres as both its own control-plane
  store and the internal per-app database option. Internal→external graduation is a
  connection-string swap to Neon/Supabase/RDS (same SQL, same `DATABASE_URL`); `JSONB` covers
  schemaless needs, `pgvector` covers AI. Internal object store = an S3-compatible service
  (leaning SeaweedFS for its Apache-2.0 license); apps speak the same S3 SDK internal or external.
- **Env model + runner internals (decided):** platform-managed vars share a reserved
  `PLATFORM_` prefix (becomes the project prefix once named); app-declared vars may not use it;
  deploys are **blocked** until every required var is set (including external-resource creds,
  which are just `PLATFORM_*` vars in `external` mode). Runner: Node buildpack → PM2 in a runner
  container; Dockerfile → sibling container via a mounted Docker socket. **Full detail spec:
  `docs/platform-spec.html`** (app.json schema, env catalog, runner topology, deploy flows).
- **Three deployment modes (one artifact):** (1) local self-managed on your own box,
  (2) self-managed on a cloud VPS (e.g., DigitalOcean), (3) future cloud-managed SaaS we host
  per-customer as a subscription. SaaS = orchestrated **single-tenant instances**, not
  multi-tenancy inside the control plane.
- **Real refactor accepted:** this is a different product than the internal SV tool;
  re-architecting storage, the control-plane store, and the runtime is in scope.
- **Name = Toolstead (working name):** env prefix `TOOLSTEAD_`, CLI `toolstead` (short alias
  `stead`), npm scope `@toolstead`. Verified free on npm + GitHub + web (chosen over "Plinth",
  which collided with an identical-concept product at plinth.run). Acknowledged placeholder —
  may revisit. Project forked to `/Users/paulstaff/Unsynced Docs/Toolstead`; `SV - Sandbox` left intact.
- **This doc** is the plan; nothing gets published until Phase 0 is clean.

## Decisions still open

- [ ] **License** — MIT (simplest, most permissive) vs Apache-2.0 (adds patent grant). Recommend MIT unless there's a reason.
- [ ] **npm scope** — `@sv/*` → `@toolstead/*`, publish unscoped, or keep vendored/unpublished.
- [ ] **Terminal endpoint**: keep always-on, or gate behind an `ENABLE_TERMINAL` env flag (recommended).
- [ ] **Internal backups**: stay local-only (single box), or optionally ship off-box to an
      external object store for durability? (The one place an external dep earns its keep.)
- [ ] **Agent doc conventions** — ship `AGENTS.md` (cross-agent), `CLAUDE.md`, both, and/or
      a Claude Code skill? Recommend: `AGENTS.md` as source of truth + a thin `CLAUDE.md`
      pointer, both emitted into every new app by the starter template.

---

## What this project is (for the README later)

A self-hosted mini-PaaS for one VPS. One droplet runs Caddy (reverse proxy + auto-HTTPS),
all app processes (via PM2), and a control-plane API + admin UI. Shared managed MongoDB
(one DB per app) and shared S3-compatible storage (one prefix per app). "Add an app" =
register in admin → connect a GitHub repo → provision → `git push` to deploy.

Components:
- `auth-api/` — Express control plane: `/verify` identity gate, admin CRUD, GitHub-webhook
  deploy engine (forked worker), Caddyfile provisioning, health monitor, SSE terminal.
- `auth-admin/` — React 19 + Vite admin dashboard (Apps / Users / Activity / Health).
- `packages/auth-client/` — server-side shim apps use to call `/verify`.
- `scripts/deploy-platform.sh` — one-shot VPS bootstrap.

Positioning note: it **deploys and hosts** apps; it does not generate app code (until the
starter template lands). Lead the README with the PaaS story, not the auth story.

AI-native angle: the platform's value is unlocked by an AI coding agent. Two audiences read
the docs — humans (setup/ops) and agents (building + deploying apps). The agent needs a
precise, prescriptive contract for the app layout, the auth integration, the auto-injected
env vars, and the deploy lifecycle. See Phase 5. (The "15-min" figure is what the
zero-external-dependency design — bundled DB + object storage, see the Product model below —
is meant to deliver: `docker compose up` and you have a working platform, no Mongo/Spaces
accounts to provision first.)

---

## Prior art & positioning

A hot, converging space in 2026 — we are not first. Three clusters:

- **Self-hosted deploy PaaS** — Coolify, Dokploy, CapRover, Dokku. Mature: deploy + DB/storage
  provisioning + routing + auto-HTTPS. But no built-in *end-user* auth for the deployed apps,
  and not AI-agent-native.
- **Bundled backends (BaaS)** — Supabase, Appwrite, **PocketBase** (single Go binary; SQLite +
  auth + storage; the zero-dependency gold standard, worth studying). Give auth+db+storage out
  of the box but do NOT deploy/host your arbitrary apps.
- **AI-native agent backends / deployers** — **OpenBerth** (getberth.dev: self-hosted, zero-dep,
  "code in → URL out," Claude builds+deploys in-conversation, gVisor sandboxing), InsForge,
  AgentBuilders. Closest to our vision; mostly emphasize deploy + secrets + logs, and several
  are hosted SaaS.

**Our wedge** = the intersection, self-hosted + zero-dep + AI-driven: (a) deploy your apps,
(b) **include end-user identity/auth + user management for those apps as a first-class
service**, and (c) let each app pick internal-or-external DB/storage. Deploy PaaS tools lack
(b); BaaS tools lack (a); AI-native ones mostly skip bundled end-user auth. Lead the README
with "auth + users included, and an AI can build & launch it on your own box."

Worth studying: PocketBase (zero-dep packaging) and OpenBerth (AI-native deploy + gVisor
isolation — a stronger isolation answer than PM2 if we ever want it).

---

## Product model — deployment modes & resource choices

**The promise:** "deploy once and don't worry about it." The platform runs with **zero
external dependencies** — it bundles its own database and object storage, uses them for its
own control-plane data, and offers them to apps.

**Three ways users run it (one artifact, different hosts):**
1. **Local, self-managed** — on a box you own. For solo devs / people building their own tools.
2. **Self-managed on a cloud VPS** — e.g., a DigitalOcean droplet. Today's model, generalized.
3. **Cloud-managed (future SaaS)** — we spin up an instance per customer, billed as a
   subscription. Implemented as **orchestrated single-tenant instances**, NOT multi-tenancy
   inside the control plane (keeps the codebase + the security model simple).

**Per-app resource choices** (set at app setup, in `app.json` + admin UI; the AI presents them):

| Resource | Internal (managed — easiest) | External (BYO) | None |
|---|---|---|---|
| Database | A DB on the platform's bundled engine, auto-provisioned + injected | User-supplied connection string (Neon/Supabase/Atlas/RDS/…) | App has no DB |
| Object storage | A bucket/prefix on the platform's bundled S3-compatible store | User-supplied S3/R2/Spaces creds | App stores nothing |

The elegance: **apps always read a connection string from an injected env var** (`DATABASE_URL`,
`S3_*`). Internal vs external is pure configuration — the AI writes the app once; the platform
decides where the string points. Graduating internal → external is a connection-string swap
(seamless when the external service speaks the same protocol — e.g. internal Postgres → Neon).

**Control-plane store = bundled Postgres (decided).** The platform's own metadata (users,
apps, deployments, auth logs) moves off the external-Mongo dependency onto the bundled
Postgres, so the platform boots with nothing external. This is the core of the "real
refactor" — the current code is `mongoose`-coupled.

---

## Phase 0 — Safety & secret hygiene ✅ (done via clean fork)

Done as a **fork**, not a scrub-in-place: the original `SV - Sandbox` is left fully intact
(still deployable to the live droplet), and a clean copy was made at
`/Users/paulstaff/Unsynced Docs/Toolstead` that never received the live secrets.

- [x] **`.gitignore` added** — covers `.env` / `.env.*` (keeps `.env.example`), `setup.conf`
      (keeps `setup.conf.example`), `node_modules/`, `dist/`, `build/`, `.DS_Store`, logs,
      `*.pem`/`*.key`, `.pm2/`, `.claude/settings.local.json`.
- [x] **Live secrets never copied** — the fork excluded `auth-api/.env` and `scripts/setup.conf`;
      only the `.example` templates are present. Verified: a secret scan of the new tree returns
      only `auth-api/.env.example` and `scripts/setup.conf.example`.
- [N/A] **Credential rotation** — intentionally NOT done. SV is still running on those creds
      (GitHub PAT, Mongo, Spaces, admin); rotating would break the live deployment, and the
      secrets aren't entering any public repo. Optional/precautionary only — revisit if a leak is suspected.
- [x] **Proprietary assets excluded** — `seniorverse-logo.svg` not copied.
- [x] **SV-internal docs excluded** — `help-center-conversion-plan.md` not copied.
- [x] **Build/junk excluded** — `node_modules/`, `auth-admin/dist/`, `.DS_Store` not copied.
- [ ] **`git init`** in the Toolstead folder (do once we're ready to track history — safe now
      that `.gitignore` is in place and no secrets are present).

---

## Phase 1 — De-Seniorverse-ify (config, not rewrites)

Replace hardcoded org coupling with config-driven values. Inventory of known sites:

- [ ] **CORS** — `auth-api/server.js:24-36` hardcodes `*.seniorverse.dev` (+ localhost) in
      logic. Make the allowed-origin pattern config-driven (derive from `BASE_DOMAIN` or a
      new `ALLOWED_ORIGIN_PATTERN`). This is the main one that's in code, not just a default.
- [ ] **`BASE_DOMAIN` defaults** → no hardcoded fallback to `seniorverse.dev`:
  - [ ] `auth-api/src/lib/provision.js:6` (also note the Caddyfile generator hardcodes
        `auth.${BASE_DOMAIN}` and `/var/www/auth-admin`).
  - [ ] `auth-api/src/routes/admin-apps.js:12` (and webhook `callbackUrl` at ~:216).
  - [ ] `scripts/deploy-platform.sh:43`.
- [ ] **Health alert email** — `health-checker.js:10` defaults to `paul@seniorverse.com`;
      lines ~93/114 build `https://${app.subdomain}.seniorverse.dev` URLs. Make domain + alert
      address config-driven.
- [ ] **Email "from"** — `auth-api/src/lib/email.js:3` hardcodes `SV Platform <noreply@seniorverse.dev>`.
      Make `EMAIL_FROM` an env var.
- [ ] **Seed admin email** — `auth-api/src/seed.js:12` defaults to `admin@seniorverse.dev`.
- [ ] **Spaces bucket default** — `scripts/deploy-platform.sh:45` defaults to `sv-tools-data`.
- [ ] **Admin UI branding** — `auth-admin/src/App.jsx:47-48` ("SV" logo mark + "Platform" text);
      check `auth-admin/index.html` `<title>` and `auth-admin/public/favicon.svg`.
- [ ] **Account page branding** — audit `auth-api/public/account.html` for SV text.
- [ ] **Package names** — `@sv/auth-api`, `@sv/auth-admin`, `@sv/auth-client` → chosen scope.
- [ ] **Rename "SV Platform"** everywhere (docs, headers, email subjects like `[SV Platform]`).

---

## Phase 2 — Honest threat model & docs (credibility)

The platform has powerful, intentional sharp edges that are fine for a *single trusted
operator on a single-tenant VPS* but dangerous if deployed naively. Don't "fix" these —
**document them loudly** and add a couple of optional guardrails.

- [ ] Write a `SECURITY.md` / "Threat model" section stating plainly: **single-tenant VPS,
      fully-trusted admins, not multi-tenant SaaS.**
- [ ] Document that the **terminal endpoint** (`admin-apps.js:518` `/:slug/exec`) is arbitrary
      RCE by design; add optional `ENABLE_TERMINAL` env gate.
- [ ] Document that **deploys execute arbitrary code**: the per-app `buildCommand`
      (`deploy-worker.js:115`) and `npm ci` postinstall scripts from connected repos run on the host.
- [ ] Audit **secret leakage into logs**: `GITHUB_PAT` is embedded in the clone URL
      (`deploy-worker.js:57`) and deploy logs are stored in Mongo + shown in the UI. Confirm the
      token never lands in stored log output.
- [ ] Note the **env-sanitization denylist** (`deploy-worker.js:187-195`) is fragile (denylist,
      not allowlist) — document, consider inverting to an allowlist.
- [ ] Document the **privilege model**: `deploy` user, `sudoers` NOPASSWD caddy reload, expected paths.
- [ ] Document the **admin auth model**: single `ADMIN_JWT_SECRET`, 8h bearer tokens in
      `sessionStorage`, no refresh/revocation. Fine at small scale; state it.

---

## Phase 3 — Bundled resources & zero-dependency core (the major refactor)

The platform bundles its own database + object storage and offers internal-or-external per
app. This is the biggest engineering change and what makes "deploy once, no external deps"
real. It is intertwined with the Phase 5 manifest (resource choices live in `app.json`).

**Bundled infrastructure (the "deploy once" artifact)**
- [ ] Ship as a `docker compose` stack: control-plane API + admin UI + Caddy + **bundled DB** +
      **bundled S3-compatible object store**. Same stack for all three deployment modes.
- [ ] Bundle **Postgres** as the internal database engine (control plane + internal app DBs).
- [ ] Bundle the internal **object store** (S3-compatible — e.g. SeaweedFS/MinIO; mind the
      license: SeaweedFS is Apache-2.0, MinIO is AGPL).
- [ ] Resolve the **app-runner design** under Hybrid compute: how PM2-managed Node apps and
      Dockerfile apps run relative to a containerized platform (host PM2 vs a runner container
      vs sibling containers via the Docker socket).

**Control-plane refactor**
- [ ] Migrate control-plane models (User, App, Deployment, AuthLog) off external Mongo onto the
      bundled Postgres, so the platform boots with zero external deps. (`mongoose` → a Postgres
      driver/ORM such as Drizzle/Prisma/Knex; only 4 small models, so it's bounded.)

**Per-app resource provisioning** (replaces the SV-specific env injection)
- [ ] Replace the `usePlatformDb` URI-rewrite hack (`admin-apps.js:100`) with a real provisioner:
      internal → create DB/schema + scoped creds + inject `DATABASE_URL`; external → inject the
      user-supplied string; none → inject nothing.
- [ ] Same for storage: internal → provision a bucket/prefix + scoped key, inject `S3_*`;
      external → inject user creds; none → nothing.
- [ ] Surface both choices in `app.json` + admin UI, and document them in the agent contract so
      the AI offers them when building an app.

**Durability (part of "don't worry about it")**
- [ ] Automated backups for internal DB + storage (scheduled `pg_dump` / object snapshots).
      Note the single-box caveat — for real safety, offer *optional* off-box backup to an
      external object store (see open decision).

**Docs**
- [ ] Reframe everything host-agnostic: "any box / any VPS"; external services are upgrades,
      never prerequisites.

---

## Phase 4 — Repo essentials for outsiders

- [ ] **Top-level `README.md`** — what it is, a screenshot/GIF, quickstart, architecture
      diagram, and a "deploy your first app" walkthrough. (None exists today.)
- [ ] **`LICENSE`** — per decision above.
- [ ] **`CONTRIBUTING.md`** — dev setup, how to run locally, PR expectations.
- [ ] Generalize **`.env.example`** and document every field.
- [ ] Fold the existing guides into a `docs/` dir, de-SV'd: `sv-platform-architecture.md`,
      `deployment-guide.md`, `app-auth-guide.md`.
- [ ] (Optional) Root **workspace `package.json`** with `dev` / `build` scripts across the
      three sub-projects.
- [ ] (Optional) **CI** (GitHub Actions) for lint + the smoke tests below.
- [ ] (Optional) Linter/formatter config (eslint/prettier).
- [ ] **Tests** — there are currently zero. At minimum, smoke tests for `/verify` and the
      `auth-client`. (Optional for v1, but adds adopter trust.)

---

## Phase 5 — AI-agent enablement & starter template (the core product loop)

This is what makes the "15-min setup, then let AI build + launch tools" thesis real. Two
deliverables: a starter template, and agent-readable docs that travel with every app.

**Starter template**
- [ ] Add `examples/starter-app/` — a minimal but real app: React/Vite frontend (`app/`,
      builds to `app/dist/`) + Express server (`server/`, entry `server.js`, mounts routes
      under `/api/*`, reads `process.env.PORT`), wired to `@<scope>/auth-client` for login and
      minting its own app-JWT session. Matches the layout the deploy worker auto-detects
      (`deploy-worker.js:97-103`) and the Caddy routing (`/api/*` → server, else → static SPA).
- [ ] Include its own `.env.example` + README documenting the platform-injected env vars.

**Agent contract docs** (source of truth, e.g. `docs/building-apps.md` + root `AGENTS.md`).
Precise and prescriptive — derived from actual platform behavior, not aspiration:
- [ ] **App layout contract:** `app/` (frontend → `dist/`) and/or `server/` (Express);
      standalone `server.js` = server-only; standalone `package.json` = frontend-only.
      Configurable `repoPath` (subdir) and `buildCommand` (default `npm run build`).
- [ ] **Routing contract:** frontend served at `https://<subdomain>.<domain>` with SPA
      fallback; server reached at `/api/*` (same-origin → no CORS). Server MUST namespace
      its routes under `/api`.
- [ ] **Auto-injected env vars** (agent must READ, never hardcode): `PORT`, `SPACES_PREFIX`;
      with platform DB → `MONGODB_URI` (scoped to the app's own DB) + `DB_NAME`; with platform
      auth → `AUTH_URL`, `APP_ID`, `APP_SECRET`, `APP_JWT_SECRET`. Extra vars declared via the
      admin UI / bulk import (or the manifest, if adopted).
- [ ] **Auth integration contract:** use `auth-client` — `verify(email, password)` →
      `{ userId, email, name }` or throws `AuthError(statusCode)`; app then mints its own
      session JWT signed with `APP_JWT_SECRET`. Document the full login flow end to end.
- [ ] **Deploy lifecycle:** register → connect repo → provision → `git push` (webhook) or
      manual deploy. Document how an agent triggers it and how it observes result/logs
      (shape depends on the autonomy-level decision above).
- [ ] **Per-repo agent context:** the starter emits `AGENTS.md` + a thin `CLAUDE.md` into
      every new app so an agent opened in that repo immediately knows the conventions.

**Agent control surface — L2: scoped token + CLI (decided)**
- [ ] **Scoped API token** distinct from the admin JWT (new `ApiToken` model, hashed at rest,
      header-presented; middleware accepts an admin JWT OR a token with the right scope). Lets
      an agent act without admin UI credentials; scope should exclude user management.
- [ ] **CLI** (`packages/cli/`) wrapping existing endpoints: `apply` (manifest-driven
      create/update + connect + provision), `deploy`, `status`, `logs`, `deploy:watch`. Reads
      `PLATFORM_URL` + `PLATFORM_TOKEN` from env. Any shell-capable agent can drive it.
- [ ] **Agent-observable deploys:** `deploy:watch` polls `GET /apps/:slug/deployments/:id`
      (already returns status + full log) until terminal, so the agent can confirm a launch
      succeeded — this is the gap that makes "AI launches it" real, not human-relayed.
- [ ] **Future (optional L3):** an MCP server wrapping the same operations as native tools for
      Claude Code / similar. Not v1 — the CLI is the universal foundation.

**App manifest — `app.json` auto-register (decided)**
- [ ] Define the manifest schema: `slug`, `name`, `subdomain`, `description`, `branch`,
      `repoPath`, `buildCommand`, `usePlatformAuth`, `usePlatformDb`, and **declared env-var
      names only** (NEVER secret values — the manifest lives in the repo).
- [ ] `cli apply` reads `app.json` and create-or-updates the app via the API, then connects
      the repo and provisions — one command, no admin clicks.
- [ ] Define **precedence** between manifest and admin-UI edits (recommend: manifest is the
      source of truth for declared fields; the UI owns secret *values* and ad-hoc overrides).
- [ ] The starter template ships a ready-to-edit `app.json` so new apps are deploy-ready.

---

## Suggested execution order

1. **Phase 0** (safety) — non-negotiable, do before `git init`.
2. **Phase 1** (de-brand) + name/license decisions — makes it genuinely reusable.
3. **Phase 4** (README + LICENSE + .gitignore polish) — minimum to be a real public repo.
4. **Phase 2** (threat model docs) — required for responsible publishing.
5. **Phase 3 + Phase 5 together** — the core build, and intertwined: the bundled-resources
   refactor (zero-dep DB/storage, internal-vs-external per app) and the AI-agent loop
   (manifest, CLI, contract docs) share the same `app.json` and provisioning surface. This is
   the bulk of turning it into the new product; gate the engine + compute details first.
6. Optional CI/tests/linting + custom domains + non-GitHub deploy — broadens reach over time.
