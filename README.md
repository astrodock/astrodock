# Astrodock

**A self-hostable, AI-native app platform.** Stand it up once on your own box, then point an AI
coding agent at it to **build, authenticate, and launch** small apps and tools on the open
internet — with **end-user auth and user management included**, and **zero external dependencies**
to boot.

> The wedge: deploy-PaaS tools host your apps but have no built-in end-user auth; bundled
> backends (BaaS) give you auth/db/storage but don't deploy your apps; AI-native deployers mostly
> skip bundled auth. Astrodock is the intersection — **self-hosted + zero-dep + AI-driven**:
> it deploys your apps, includes identity/auth for them, and lets each app pick internal-or-external
> database and storage.

```
                       ┌──────────────── your box / VPS ────────────────┐
  *.your-domain ─TLS──▶ │  caddy      reverse proxy + auto-HTTPS           │
                        │  api        control plane · /verify · webhooks   │
                        │  runner     clones, builds, runs your apps       │
                        │   ├─ PM2 ──▶ node app  (buildpack)               │
                        │   └─ docker▶ app-<slug> container (Dockerfile)   │
                        │  postgres   bundled DB (control plane + apps)    │
                        │  objectstore bundled S3-compatible storage       │
                        └─────────────────────────────────────────────────┘
```

## Why
- **Auth + users included.** Platform-managed end-user login (the `/verify` model) is first-class —
  apps verify credentials against the control plane and mint their own sessions.
- **Zero external dependencies.** Bundles its own Postgres and S3-compatible object storage and
  uses them for its own control-plane data. External managed services are an *upgrade*, never a
  prerequisite.
- **AI builds & launches it.** An `app.json` manifest + a thin CLI (`astrodock`) + agent-readable
  docs (`AGENTS.md`) give a coding agent a precise, drivable contract: scaffold → provision →
  deploy → observe.
- **Per-app resource choice.** Database and object storage are each `internal` (managed),
  `external` (bring your own), or `none` — and app code is identical either way, because apps
  read a connection string from injected env.
- **Hybrid compute.** Node buildpack by default (PM2), or ship a `Dockerfile` for any runtime.

## Documentation
Full, beginner-friendly docs are published at **https://astrodock.github.io/astrodock/** and live in
[`docs/`](docs/index.html) — a static site you can also open locally (`open docs/index.html`) or host
anywhere. Start with **Introduction → Install & run →
Deploy your first app**, then the topic guides (custom domains & DNS, email notifications, external
database/storage, users, secrets, backups…). The quickstart below is the short version.

## Quickstart
On a fresh server:
```bash
curl -fsSL https://get.astrodock.dev | sh
```
Then open `http://<your-server-ip>` and finish in the browser. That one line downloads the compose
file, generates every secret, pulls the images, and starts the stack — no source tree, no build, no
config to hand-edit. The setup wizard creates your administrator account (using a one-time token
printed to the log), takes your domain, **shows you the exact DNS record to add and checks it for
you**, then switches on HTTPS and hands you your real dashboard URL.

That's the whole platform: control plane + admin UI + auto-HTTPS routing + bundled Postgres +
bundled object storage.

<details>
<summary>Prefer the shell, or building from source?</summary>

Every wizard step has a flag, and nothing forces you to trust a prebuilt image:

```bash
git clone https://github.com/astrodock/astrodock.git && cd astrodock

./scripts/setup.sh                       # generate .env — asks nothing, browser setup
./scripts/setup.sh --domain apps.example.com --email you@example.com \
                   --admin-email you@example.com --admin-password '…'   # skip the wizard entirely
./scripts/setup.sh --local               # localhost, plain HTTP, for a try-out

docker compose up -d                                  # run the published images
docker compose -f docker-compose.yml \
               -f docker-compose.build.yml up -d --build   # build from this source tree
```
Or `cp .env.example .env` and edit it by hand (`openssl rand -hex 32` for secrets).
</details>

## Launch your first app
From an app repo (start from [`examples/starter-app`](examples/starter-app)):
```bash
export ASTRODOCK_URL=https://admin.your-domain     # your admin host
export ASTRODOCK_TOKEN=tk_...                       # create one in the admin UI → Tokens

astrodock apply              # create the app from app.json, connect the repo, provision
astrodock deploy:watch       # deploy and stream the log until it's live
```
Then grant a user access in the admin UI and visit `https://<subdomain>.your-domain`.

**Building an app:** see the docs site — [App structure & app.json](docs/building-apps.html) — or,
for AI agents specifically, [`AGENTS.md`](AGENTS.md). The `app.json` schema lives in
[`packages/schema`](packages/schema).

## Repository layout
```
apps/control-plane/   Express API · /verify · deploy orchestration · runner · health
apps/admin/           React admin UI (apps · users · tokens · activity · health)
packages/auth-client/ @astrodock/auth-client — server-side /verify client
packages/cli/         @astrodock/cli — astrodock / adock (apply, deploy, status, logs, set-secret)
packages/schema/      @astrodock/schema — app.json JSON Schema + validator + env catalog
examples/starter-app/ a real app to copy from
docs/                 the documentation site (index.html) + platform-spec.html
docker-compose.yml    the whole stack
```

## How it works
- **Manifest.** Each app repo carries an `app.json` declaring routing, runtime, resource modes,
  and env-var *names* (never secret values). `astrodock apply` reconciles the platform to it.
- **Environment model.** Platform-managed vars use the reserved `ASTRODOCK_` prefix and are
  injected at deploy; app-declared vars come from `app.json`. A deploy is **blocked** until every
  required value is set.
- **Provisioning.** `internal` database → a Postgres DB + role; `internal` storage → a bucket
  prefix on the bundled store; `external` → you supply the connection string / S3 creds; `none` →
  nothing. Routing is reconfigured in Caddy automatically.
- **Deploy.** Webhook on `git push` (or `astrodock deploy`) → clone → build → run (PM2 or a
  sibling Docker container) → health probe → observable deploy record + streamed log.

Full technical contract: [`docs/platform-spec.html`](docs/platform-spec.html).

## Deployment modes
One artifact, three ways to run it: (1) local on your own box, (2) self-managed cloud VPS,
(3) a future managed SaaS as orchestrated single-tenant instances. The
[Install &amp; run](docs/install.html) and [Custom domains &amp; DNS](docs/custom-domains.html)
guides cover both local and server installs — any VPS or box.

## Security model — read this
Astrodock is designed for a **single trusted operator on a single-tenant box**, not multi-tenant
SaaS. It has powerful, intentional sharp edges (the runner builds and executes code from your
repos; the optional terminal is arbitrary RCE; the Docker socket is mounted). These are fine for
the intended model and dangerous if deployed naively. **Read [`SECURITY.md`](SECURITY.md) before
exposing this to untrusted users or networks.**

## Status
Working name **Astrodock** (may be revisited). This is an active rebuild forked from an internal
tool — see [`OPEN_SOURCE.md`](OPEN_SOURCE.md) for the roadmap, [`DECISIONS.md`](DECISIONS.md) for
the choices made, and [`BUILD_NOTES.md`](BUILD_NOTES.md) for what's verified vs. needs a real
Docker host to exercise.

## License
[MIT](LICENSE).
