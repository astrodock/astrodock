# Hosted Astrodock: Build Plan

The hosted service is deployment mode 3 from `OPEN_SOURCE.md`: a customer signs up and pays,
and gets their own Astrodock instance on a DigitalOcean droplet. An AI agent can do the whole
setup with one command and a browser page.

This promotes items from `MULTI_TENANT.md` into a build plan. The instance side is in this
repository. The service itself (sign-up, billing, the fleet) is the separate private
repository `astrodock-cloud`, next to this one; it has no remote yet.

**Status words.** Testing: built, covered by tests, not yet verified by Paul. Pending sign-off:
an outward step (money, a publish, DNS, a deploy) that waits for approval. Not built: not done.

## Decisions

Decided by Paul, 2026-11-01 and 2026-11-02.

| Area | Decision |
|---|---|
| Hosting | One DigitalOcean droplet per customer, running the standard `docker compose` stack |
| Cloud service | Its own dedicated droplet, as an app on its own Astrodock instance (D5) |
| Onboarding | `npx @astrodock/cli login`, the same command for new and existing accounts |
| Pool | Warm pool of pre-booted droplets, assigned at payment. Min, max and auto-sizing set in the fleet admin |
| Keys | The user chooses. A key for one app is the default; a key for the whole account is an option |
| Approval | Actions beyond one app need approval in the browser with a passkey or authenticator code, every time |
| Factors | Passkey strongly encouraged and shown first. Authenticator app (TOTP) allowed |
| Runtime limits | Per-app CPU and memory caps, and outbound traffic monitoring. Required before launch |
| Billing | Charge at signup. Full refund within 14 days. One instance per card. Stripe Radar on |
| D1 | Node apps run in a container of their own. `ASTRODOCK_NODE_RUNTIME=container`; new installs and hosted instances get it, an existing install keeps PM2 until it opts in |
| D2 | A customer domain on the Public Suffix List; certificates per hostname over HTTP-01 |
| D3 | A new domain, separate from astrodock.ai. Name not chosen |
| D4 | A separate private repository: `astrodock-cloud` |
| D5 | The service is an app on its own dedicated Astrodock instance |
| D6 | Plans are configuration (`CLOUD_PLANS`): name, price, Stripe price, droplet size. Sizes and prices not set |
| D7 | 60 days of retention after cancel, as a snapshot; restore by choosing a plan again |
| D8 | One region at launch (`DO_REGION`) |

## The Flow

1. The agent runs `npx @astrodock/cli login` in an app repo.
2. The CLI starts a sign-in at the service with the S256 hash of a verifier it keeps, opens
   `/start?code=…` and prints it.
3. The person signs up (an invite from the service's own platform, emailed, which proves the
   address) or signs in, sees the request (computer, folder, app), chooses a plan, and pays in
   Stripe Checkout.
4. The Stripe webhook assigns a ready pool droplet. The claim, step by step: start a CLI sign-in
   on the instance with the same hash (`/fleet/cli-login`), create `*.name` and `name` DNS
   records, claim (`/fleet/claim`: domain, owner by email, and a new fleet token), wait until
   `https://admin.<name>.<domain>` answers.
5. The browser goes to the instance's welcome link: add a passkey, or a password and an
   authenticator app. It lands on `/connect/<code>`.
6. The person approves a key for this app (default) or every app, with a passkey or code.
7. The CLI is handed the instance's device code by the service, polls the instance with its
   verifier, collects the key, writes `.env.astrodock` (0600) and adds it to `.gitignore`.
8. The agent runs `astrodock apply` and `astrodock deploy:watch --local`.

The service never has the verifier, so it can never collect a key. A self-hosted user runs
`astrodock login --url <admin URL>` and starts at step 6. An existing customer skips 3 to 5.

`astrodock-cloud/server/test/e2e.test.js` runs this flow with the real control plane as the
instance and the real CLI, with DigitalOcean, Stripe, the platform and email faked.

## Threat Model

In `SECURITY.md`, "Hosted mode": what is enforced and what is not.

## Phase 1: Instance Work (Ships in the Open-Source Product)

| # | Item | Status |
|---|---|---|
| 1.1 | Publish `@astrodock/cli` and `@astrodock/schema` to npm | Release job built; skips without an `NPM_TOKEN` secret. Publishing: pending sign-off |
| 1.2 | `astrodock login` | Testing |
| 1.3 | Login sessions on the instance (`/cli/login/start`, `/cli/login/poll`, PKCE) | Testing |
| 1.4 | Approval page `/connect/<code>` | Testing. Not looked at in a browser |
| 1.5 | Passkey or authenticator code on every approval (`lib/strong-factor.js`) | Testing |
| 1.6 | Approvals for keys: create app, existing person to an app, custom domain (`/approve/<id>`) | Testing |
| 1.7 | Presets `agent` (one app) and `agentAccount` (every app, plus Pages) | Testing |
| 1.8 | Per-app memory and CPU caps; Node apps in containers (D1) | Testing. The Docker paths have not run: there was no Docker here |
| 1.9 | Per-app traffic metering and alert | Testing. The sampler has not run against Docker |
| 1.10 | Passkey encouragement on Your Account and the welcome page | Testing |
| 1.11 | Cookies: `__Host-` prefix over HTTPS for sign-in and Pages | Testing |
| 1.12 | A one-app key lists only that app's people | Testing |

## Phase 2: Instance Image, Provisioning and Pool

| # | Item | Status |
|---|---|---|
| 2.1 | Image builder (no SSH; the image holds no secrets) | Testing, against a fake DigitalOcean |
| 2.2 | Pool boot: stock installer with tokens in user-data; `install.sh` passes them into `.env` | Testing |
| 2.3 | Claim endpoint (`/fleet/claim`), welcome link (`/fleet/owner-link`) | Testing |
| 2.4 | DNS records per customer | Testing, against a fake. The domain (D3) and its PSL entry: pending sign-off |
| 2.5 | Firewall: 80 and 443 in, SMTP out blocked | Testing, against a fake |
| 2.6 | Pool manager with auto-sizing and the droplet limit | Testing |
| 2.7 | Assigning without billing, from the fleet admin | Testing |
| 2.8 | Fleet token replaced at the claim; containers cut off from the metadata address; no downgrades through the fleet API | Testing |

## Phase 3: Accounts, Billing and Signup

| # | Item | Status |
|---|---|---|
| 3.1 | Customer accounts through the service's own platform (invite by email, then hosted sign-in) | Testing |
| 3.2 | `/start` page | Testing. Not looked at in a browser |
| 3.3 | Stripe Checkout, webhooks (signature checked, each event once), Radar | Testing, against a fake. A Stripe account and products: pending sign-off |
| 3.4 | One instance per card (fingerprint) | Testing |
| 3.5 | Cancel: full refund within 14 days; after that, at period end | Testing |
| 3.6 | Email through Resend | Testing. Never sent for real |
| 3.7 | End to end from an empty repo | Testing, simulated (e2e.test.js). For real: pending sign-off |

## Phase 4: Fleet Operations and Lifecycle

| # | Item | Status |
|---|---|---|
| 4.1 | Fleet admin `/staff`: pool, sign-ups per day, droplet limit, needs attention, image, upgrades, instances | Testing. Not looked at in a browser |
| 4.2 | Rolling upgrades in batches | Testing |
| 4.3 | Health checks per instance | Testing |
| 4.4 | Off-box backups to Spaces while running | Not built. Cancelled instances are kept as snapshots (4.7); a running instance's backups stay on the droplet |
| 4.5 | Outbound bandwidth abuse signal; suspend and resume | Testing |
| 4.6 | Plan change: Stripe price and a CPU/RAM resize | Testing |
| 4.7 | Lifecycle: cancel, snapshot, 60 days, reminder a week before, delete; restore from snapshot | Testing |

## Phase 5: Launch

| # | Item | Status |
|---|---|---|
| 5.1 | `SECURITY.md` hosted-mode section | Written |
| 5.2 | Terms, acceptable use, privacy | Drafts in `astrodock-cloud/docs/legal/`, with bracketed open items. Need review by counsel |
| 5.3 | Agent discovery (`llms.txt`) | Draft in `astrodock-cloud/docs/discovery/`; moves to the site at launch. The docs contract (`astrodock-docs/AGENTS.md`) now covers `astrodock login` and approvals. Deploying either: pending sign-off |
| 5.4 | Higher DigitalOcean droplet limit | Pending sign-off |

## Open Items for Paul

| Item | What Is Needed |
|---|---|
| Customer domain (D3) | The name. Then its DNS on DigitalOcean and a Public Suffix List request |
| Service address | The CLI's default is `https://cloud.astrodock.ai` (`packages/cli/src/login.js`), a placeholder until the service's own address is chosen |
| Plans (D6) | Droplet sizes and prices, after measuring the stack's idle memory |
| Legal | Company name, address, governing law, contact email, and counsel's review |
