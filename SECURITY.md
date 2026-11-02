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
- The hosted mode is **orchestrated single-tenant instances**, never multi-tenancy inside one
  control plane. See "Hosted mode" below for what changes inside an instance.

## Hosted mode

The hosted service (`HOSTED_SERVICE.md`; the service itself is the separate `astrodock-cloud`
repository) runs one instance per customer on its own DigitalOcean droplet. The droplet is the
boundary between customers: nothing in one customer's instance can reach another's. What
changes is inside one instance: the owner is a customer rather than the person who runs the
box, and the apps on it may be code someone talked them into installing.

The case it is built against: someone gets a customer to install their app, and text in that
app's repository tells the customer's agent what to do with whatever key it can find.

What is enforced:
- **Keys are per app by default.** `astrodock login` mints a key for the one app in the folder
  (preset `agent`); a key for every app (`agentAccount`) is the person's explicit choice. Neither
  preset can mint keys, delete apps, run commands, change settings, run backups or reply to
  users.
- **Reaching past one app needs a person.** A key that creates an app, adds a custom domain, or
  gives an app access to someone who already has an account gets `approval_required` and a link
  (`lib/approvals.js`). Approving needs a passkey or an authenticator code on every decision, not
  a recent sign-in, so an agent driving the browser cannot click it through. A password does
  not count. Passkeys are offered first: a code can be read out to whoever asks for it in a
  chat; a passkey cannot.
- **A one-app key sees only that app's people** in the user list.
- **Node apps run in containers of their own** (`ASTRODOCK_NODE_RUNTIME=container`, set on every
  hosted instance and on new installs). The build runs in a throwaway container on Docker's
  default bridge network, as uid 1000, with the app's own environment read from a file that is
  deleted before any app code runs. The app runs with memory, CPU and process caps, no Linux
  capabilities and `no-new-privileges`. Neither ever runs in the runner, which holds the Docker
  socket and the GitHub PAT.
- **Per-app traffic is counted** from each container's own counters, with a warning event above
  `alerts.app_traffic_mb_per_hour`. The hosted service also watches each droplet's outbound
  bandwidth and raises an abuse event for staff, who can suspend the instance.
- **Outbound SMTP is blocked** by the hosted droplets' firewall (port 25), and inbound is 80 and
  443 only.
- **The fleet token is small and short-lived in its first form.** It can claim a fresh instance
  once (together with the setup token), mint a welcome link only while the owner has no way to
  sign in, start a CLI sign-in that a person still has to approve and that only the CLI's PKCE
  verifier can collect, read status, and start an update, never a downgrade. The token the
  droplet boots with arrives in user-data, which DigitalOcean serves to anything on the droplet
  at `169.254.169.254`; the claim replaces it with one only the service knows, and hosted
  droplets drop container traffic to that address at the host.
- **The server terminal is off** on hosted instances (`ASTRODOCK_SERVER_TERMINAL=off`).
- **Sign-in and Pages cookies carry the `__Host-` prefix** over HTTPS, so an app on a sibling
  subdomain cannot plant one.

What is not:
- An app can still send its own data, and its users' data, anywhere. Traffic is counted, not
  filtered.
- An app can show a convincing fake of the sign-in page to its own visitors.
- A hijacked agent on the customer's laptop can read every `.env.astrodock` on that disk and use
  those keys within their scope. The approval step is what stops it reaching further.
- Customers share one domain until it is on the Public Suffix List; until then, cookies set by
  one customer's apps on the shared parent domain are visible to the others' apps, and all their
  certificates count against one Let's Encrypt limit.

## Sharp edges (intentional)
- **The runner executes code from your repos.** Deploys run `npm ci` (which can run postinstall
  scripts), your `buildCommand`, and your app — on the host/runner. Connect only repos you trust.
- **Dockerfile apps use a mounted Docker socket.** `runtime.type: "docker"` builds and runs
  sibling containers via `/var/run/docker.sock`, which is **root-equivalent on the host**. This is
  accepted under the trusted-operator model.
- **The per-app terminal is arbitrary RCE.** `POST /admin/apps/<slug>/exec` streams shell commands
  over SSE. It is registered only when the runner has `ASTRODOCK_ENABLE_TERMINAL=true`, and it is
  gated on the `exec` scope, which is in the sensitive group, appears in no key preset, and is not
  carried by the operator role. Commands run **on the runner**, in the app's own directory, as the
  app's own user, with the app's own environment and nothing of the platform's; output has the
  app's secret values masked; every invocation is written to the audit trail with its text before
  it runs. That bounds it to the blast radius of the app itself rather than the platform, but a
  shell is still a shell. Leave it off unless you understand and accept this.
- **The server terminal is root on the host, by design.** `POST /admin/server/exec` (the Server
  page, and `astrodock server run`) starts a short-lived privileged container that enters the
  host's namespaces with `nsenter` and runs the command as root, exactly as SSH would. It adds no
  privilege the runner's Docker socket does not already hold; it makes that privilege usable from
  the dashboard. It is on by default and can be switched off with `ASTRODOCK_SERVER_TERMINAL=off`
  in `.env`. It needs the `server:exec` permission, which only the **owner** role holds (not
  admin), which is in no key preset, and which a key can never pass on. A key that carries it can
  only be created by an owner, cannot be limited to apps, and expires within **24 hours** whatever
  was requested. Every command is written to the audit trail, with its text and who ran it
  (person or key), before it runs. Output has the platform's own secret values masked. Commands
  stop after 15 minutes or when the caller disconnects.
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
- **Caddy admin API** listens on a unix socket (`/run/caddy-admin/admin.sock`) in a volume only
  the `caddy` and `api` containers mount. No app can reach it. Older compose files put it on
  `:2019` on the shared network instead, where any app could rewrite routing; see
  [Older installs](#older-installs).
- **The bundled object store** is split in two. The `seaweed` service (master, volume server,
  filer, S3 gateway) sits on an internal `storage` network no app joins. The `objectstore`
  service is an HTTP proxy that forwards only the S3 port, `:8333`. Apps hold per-app keys
  scoped to their own bucket. The filer, master and volume ports have no authentication, which
  is why nothing but the proxy can reach them. If a per-app key cannot be created, provisioning
  fails; it no longer falls back to the platform's admin key.
- **The runner token** has no default. The runner refuses to start when it is unset or set to the
  old published placeholder, and compares it in constant time.
- **Backups** (`/data/backups`) are root-only: the directory is `0700`, each dump `0600`. PM2's
  home, which holds every Node app's environment, is `0700`.
- Only Caddy's `80`/`443` should be published to the internet.

### Older installs
An update replaces the images, never `docker-compose.yml` or `infra/caddy/Caddyfile` on the
host. An install made before the socket and storage split keeps its old topology (Caddy admin
on `:2019`, one `objectstore` container on the shared network) until both files are replaced:

```sh
cd <install dir>
curl -fsSL https://raw.githubusercontent.com/astrodock/astrodock/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/astrodock/astrodock/main/infra/caddy/Caddyfile -o infra/caddy/Caddyfile
grep -q '^ASTRODOCK_RUNNER_TOKEN=.' .env || echo "ASTRODOCK_RUNNER_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --remove-orphans
```

The object data volume is kept. The control plane works with either topology.

## Remaining known limitations
- The runner container itself is privileged (holds the Docker socket ≈ host root and the GitHub
  PAT). App build + runtime drop to a non-root per-app user, but a bug in the runner's own
  orchestration code, or a Dockerfile-app escape via the socket, is bounded only by the runner
  container. The trust boundary is the runner container.
- Apps (Node apps in the runner, and Dockerfile apps) share one Docker network with the control
  plane, Caddy's proxy ports, the runner API (token-authed) and the S3 proxy. They cannot reach
  the Caddy admin API or the storage core. Node apps also share the runner's network namespace
  and process table, so one app can see another's process names and bind a port another app
  has released. Put only apps you trust on the box.
- Apps can reach the cloud metadata service (`169.254.169.254`) unless the host blocks it.
- No multi-admin RBAC — admins are all-powerful (per-app scoping exists only for API tokens).

## Operator guidance
- Put the box behind a firewall; expose only 80/443.
- Use strong, unique values for `ASTRODOCK_ADMIN_JWT_SECRET`, `ASTRODOCK_PG_PASSWORD`,
  `ASTRODOCK_OBJECTSTORE_SECRET_KEY`, and the admin password. Never commit `.env`.
- Connect only repos you control. Review `buildCommand` and dependencies.
- Back up `pgdata` and `objectdata` (see `scripts/backup.sh`).

## Reporting a vulnerability
This is an early-stage project. Open a private security advisory on the repository, or email the
maintainer. Please don't file public issues for sensitive reports.
