# Security & threat model

Toolstead is built for **one trusted operator running a single-tenant box** — your own machine
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
  app's context. It is **OFF by default** and only mounted when `TOOLSTEAD_ENABLE_TERMINAL=true`.
  Leave it off unless you understand and accept this.
- **GitHub PAT in clone URLs.** The runner clones with `https://x-access-token:<PAT>@…`. The token
  is not written to stored deploy logs, but treat the runner host as holding that credential.

## Admin & token model
- **Admin auth:** a single `TOOLSTEAD_ADMIN_JWT_SECRET`, 8-hour bearer JWTs, no refresh/revocation.
  Fine at small scale; rotate the secret to invalidate all admin sessions.
- **Scoped API tokens (`tk_…`):** SHA-256-hashed at rest, shown once at creation. They can manage
  apps/deploys/env but **cannot manage users or other tokens**. Revoke in the admin UI.
- **End-user passwords:** bcrypt (12 rounds). `/verify` is rate-limited; results are logged to
  `auth_logs` (pruned after 90 days).

## Network surface
- **Caddy admin API** (`:2019`) is bound for the control plane to push routing config. It is
  intended to live **only on the internal compose network** — do not publish port 2019.
- **The bundled object store (SeaweedFS S3) is reachable only on the internal network** and, in
  v1, is **not credential-authenticated** at the S3 layer (see the v1 gap below). Do not expose it.
- Only Caddy's `80`/`443` should be published to the internet.

## Known v1 simplifications (flagged for review)
- **Internal object-storage isolation is by prefix, not by key.** All apps in `storage.mode:
  internal` share one bucket and one platform access key, each scoped to its own key *prefix*
  (`<slug>/`). The injected env var set is identical to the per-app-key design, so app code never
  changes when this is upgraded. For hard isolation today, use `storage.mode: external`. See
  `DECISIONS.md` (B3).
- **The runner is merged into the `api` container for v1.** This widens that container's blast
  radius (it has git + Docker socket + PM2). Splitting the runner into its own service is a
  packaging change planned post-v1. See `DECISIONS.md` (B1).
- App processes run as root inside the runner container in v1.

## Operator guidance
- Put the box behind a firewall; expose only 80/443.
- Use strong, unique values for `TOOLSTEAD_ADMIN_JWT_SECRET`, `TOOLSTEAD_PG_PASSWORD`,
  `TOOLSTEAD_OBJECTSTORE_SECRET_KEY`, and the admin password. Never commit `.env`.
- Keep `TOOLSTEAD_ENABLE_TERMINAL=false` unless you need it.
- Connect only repos you control. Review `buildCommand` and dependencies.
- Back up `pgdata` and `objectdata` (see `scripts/backup.sh`).

## Reporting a vulnerability
This is an early-stage project. Open a private security advisory on the repository, or email the
maintainer. Please don't file public issues for sensitive reports.
