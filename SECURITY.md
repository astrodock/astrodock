# Security & threat model

Astrodock is built for **one trusted operator running a single-tenant box** — your own machine
or a VPS you control, where you (and any admins you create) are fully trusted. It is **not**
multi-tenant SaaS and must not be exposed to untrusted users or untrusted networks without
additional hardening. Several capabilities are powerful by design; this document states them
plainly rather than pretending they aren't there.

## Intended model
- A single VPS / box, operated by a trusted person.
- Admins are fully trusted. End-users (the people who log into the *apps* via `/verify`) are
  untrusted and isolated to app-level auth only — they never touch the control plane.
- The future managed-SaaS mode is **orchestrated single-tenant instances**, never multi-tenancy
  inside one control plane.

## Sharp edges (intentional)
- **The runner executes code from your repos.** Deploys run `npm ci` (which can run postinstall
  scripts), your `buildCommand`, and your app — on the host/runner. Connect only repos you trust.
- **Dockerfile apps use a mounted Docker socket.** `runtime.type: "docker"` builds and runs
  sibling containers via `/var/run/docker.sock`, which is **root-equivalent on the host**. This is
  accepted under the trusted-operator model.
- **The per-app terminal is arbitrary RCE.** The `/exec` SSE endpoint runs shell commands in an
  app's context. It is **OFF by default** and only mounted when `ASTRODOCK_ENABLE_TERMINAL=true`.
  Leave it off unless you understand and accept this.
- **GitHub PAT in clone URLs.** The runner clones with `https://x-access-token:<PAT>@…`. The token
  is not written to stored deploy logs, but treat the runner host as holding that credential.

## Data protection
- **Secrets are encrypted at rest** (AES-256-GCM) when `ASTRODOCK_SECRET_KEY` is set: app secrets,
  app JWT secrets, internal DB passwords, webhook secrets, and secret env values. Set this key —
  without it the control plane stores secrets in plaintext and warns at boot.
- **App build runs unprivileged with no platform secrets.** `npm`/postinstall/`buildCommand` run
  as the app's own non-root user with a scrubbed env containing only the app's own injected vars —
  never the platform stack secrets (`ASTRODOCK_SECRET_KEY`, the Postgres superuser password, the
  object-store master key, the admin JWT secret, the runner token, the GitHub PAT). The GitHub PAT
  is passed to git via a per-invocation header and never written to the cloned repo's `.git/config`.
- **Per-app database isolation:** each internal-DB app gets its own Postgres database + login
  role, and `CONNECT` is revoked from `PUBLIC` (on app DBs *and* the control-plane DB), so an
  app's role can't reach another app's data or the control plane's.
- **Per-app object-storage isolation:** each internal-storage app gets its own bucket + a scoped
  S3 key (minted in SeaweedFS) limited to that bucket. If a scoped identity can't be minted, it
  falls back to a shared key + per-app prefix and says so in the provision output.
- **Per-app process isolation:** Node buildpack apps run as their own non-root OS user with
  600-perm env files, so apps can't read each other's secrets/code. Dockerfile apps are isolated
  by container.

## Admin & token model
- **Admin auth:** a single `ASTRODOCK_ADMIN_JWT_SECRET`, 8-hour bearer JWTs, no refresh/revocation.
  Fine at small scale; rotate the secret to invalidate all admin sessions. (Multi-admin RBAC is
  future work — all admins are equally privileged.)
- **Scoped API tokens (`tk_…`):** SHA-256-hashed at rest, shown once. They can manage
  apps/deploys/env but **cannot manage users or other tokens**, and may be **restricted to specific
  app slugs** (`apps: [...]` at creation). Revoke in the admin UI.
- **End-user passwords:** bcrypt (12 rounds). `/verify` is rate-limited; results are logged to
  `auth_logs` (pruned after 90 days).

## Network surface
- **The runner is a separate container** holding the Docker socket + GitHub PAT + PM2; the
  control-plane (`api`) container holds neither (verified: no socket, blank PAT). The runner's
  internal API is token-authed and reachable only on the compose network. Socket access is still
  ≈ host root, but confined to the runner.
- **Caddy admin API** (`:2019`) lives only on the internal network — do not publish port 2019.
- **The bundled object store** is internal-only and uses S3 identities (platform admin + per-app
  scoped keys), not anonymous access. Do not expose it.
- Only Caddy's `80`/`443` should be published to the internet.

## Remaining known limitations
- The runner container itself is privileged (holds the Docker socket ≈ host root and the GitHub
  PAT). App build + runtime drop to a non-root per-app user, but a bug in the runner's own
  orchestration code, or a Dockerfile-app escape via the socket, is bounded only by the runner
  container. The trust boundary is the runner container.
- Dockerfile apps share one Docker network with the control plane/Caddy; a deployed Dockerfile
  app could reach internal services (objectstore, caddy admin, runner) on that network. Put only
  trusted Dockerfile apps on the box, or segment the network.
- No multi-admin RBAC — admins are all-powerful (per-app scoping exists only for API tokens).
- The optional terminal (`ASTRODOCK_ENABLE_TERMINAL`) remains arbitrary RCE and off by default.

## Operator guidance
- Put the box behind a firewall; expose only 80/443.
- Use strong, unique values for `ASTRODOCK_ADMIN_JWT_SECRET`, `ASTRODOCK_PG_PASSWORD`,
  `ASTRODOCK_OBJECTSTORE_SECRET_KEY`, and the admin password. Never commit `.env`.
- Keep `ASTRODOCK_ENABLE_TERMINAL=false` unless you need it.
- Connect only repos you control. Review `buildCommand` and dependencies.
- Back up `pgdata` and `objectdata` (see `scripts/backup.sh`).

## Reporting a vulnerability
This is an early-stage project. Open a private security advisory on the repository, or email the
maintainer. Please don't file public issues for sensitive reports.
