# Toolstead — project context for Claude

**Toolstead** is an open-source, self-hostable, **AI-native app platform**: stand it up once,
then point an AI agent (Claude Code or similar) at it to build, authenticate, and **launch**
small apps/tools on your own box. It bundles its own database + object storage (zero external
dependencies) and deploys, hosts, auths, routes, and monitors the apps you point it at.

This repo was **forked from an internal Seniorverse ("SV") tool and is being rebuilt.** Read
these before doing substantial work — they are the source of truth:

- **`BUILD_PLAN.md`** — the current, ordered work plan. **Start here.**
- `OPEN_SOURCE.md` — phased roadmap, all locked decisions, and the de-brand inventory (file:line).
- `docs/platform-spec.html` — the technical spec: `app.json` schema, the env-var model, the
  runner topology, and deploy flows. Authoritative for those details.

## Locked decisions (do not re-litigate)
- **Name:** Toolstead (working name). Env prefix `TOOLSTEAD_`, CLI `toolstead` (alias `stead`), npm scope `@toolstead`.
- **Zero external deps:** control plane + internal app DBs on **Postgres**; internal object
  storage on an S3-compatible store (**SeaweedFS**, Apache-2.0). Ships as a `docker compose` stack.
- **Per-app resources:** each app chooses **internal / external / none** for database and for
  object storage. Apps read a connection string from injected env either way (internal vs external is pure config).
- **Auth:** platform-managed end-user auth (the `/verify` model) is a first-class feature — this is a key differentiator.
- **Compute = Hybrid:** Node buildpack (PM2 inside a runner) by default; optional Dockerfile
  (sibling container via a mounted Docker socket).
- **Agent surface:** a scoped API token (separate from admin JWT) + a thin CLI (`apply` / `deploy` / `status` / `logs` / `deploy:watch`).
- **Manifest:** each app repo carries `app.json` — declared config + env-var *names* only, never secret values.
- **Env model:** all platform-managed vars use the reserved `TOOLSTEAD_` prefix; app-declared
  vars may not. Deploys are blocked until every required var is set.
- **Routing:** Caddy serves static it can see (Node buildpack apps) and whole-proxies opaque apps (Docker). Intentional; keep it.

## Guardrails
- **Do NOT touch the sibling `../SV - Sandbox` folder** — it's the original internal tool, still running in production. Don't modify it or rotate its credentials.
- **Secrets stay out of git:** `.env*` and `setup.conf` are gitignored. Only `*.example` files are committed.
- **This is a rebuild:** treat the forked SV code as *reference* to port where reusable (auth routes, deploy-worker logic, admin UI shell) — not as finished code.
- Commit per milestone. End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Ask before outward/irreversible actions (adding a git remote, pushing, publishing).
