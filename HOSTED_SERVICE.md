# Hosted Astrodock: Build Plan

The hosted service is deployment mode 3 from `OPEN_SOURCE.md`: a customer signs up and pays,
and gets their own Astrodock instance on a DigitalOcean droplet. An AI agent can do the whole
setup with one command and a browser page.

This promotes items from `MULTI_TENANT.md` into a build plan. Status of everything here:
**not built**, unless a row says otherwise.

## Decisions

Decided by Paul, 2026-11-01 and 2026-11-02.

| Area | Decision |
|---|---|
| Hosting | One DigitalOcean droplet per customer, running the standard `docker compose` stack |
| Cloud service | Runs on its own dedicated droplet. Holds signup, billing, the provisioner and the fleet admin |
| Onboarding | `npx @astrodock/cli login`, the same command for new and existing accounts |
| Pool | Warm pool of pre-booted droplets, assigned at payment. Min, max and auto-sizing set in the fleet admin |
| Keys | The user chooses. A key for one app is the default; a key for the whole account is an option |
| Approval | Actions beyond one app need approval in the browser with a second factor, every time |
| Factors | Passkey strongly encouraged and shown first. Authenticator app (TOTP) allowed |
| Runtime limits | Per-app CPU and memory caps, and outbound traffic monitoring. Required before launch |
| Billing | Charge at signup. Full refund within 14 days. One instance per card. Stripe Radar on |

## The Flow

1. The agent runs `npx @astrodock/cli login` in an app repo.
2. The CLI starts a session with the cloud service and gets a URL and a short code. It opens
   the URL in the browser and prints it for agents that cannot open one.
3. The `/start` page shows plans, price and the 14-day refund terms. The user creates an
   account (passkey first, authenticator app as the alternative) and pays in Stripe Checkout.
4. The Stripe webhook tells the cloud service to assign a pool droplet. The page shows progress.
5. The cloud service configures the instance: domain, DNS, and the owner account for the user's
   email.
6. The browser moves to the instance's own approval page. The user picks a key for this app or
   for the account, and confirms with their factor.
7. The instance mints the key. The CLI receives it once, writes `.env.astrodock`, and adds it to
   `.gitignore`.
8. The agent runs `astrodock apply` and `astrodock deploy:watch --local`.

An existing user skips steps 3 to 5. A self-hosted user runs `astrodock login --url <admin URL>`
and starts at step 6, so the login and approval pieces are part of the open-source product.

Keys are minted by the instance and delivered to the CLI directly. They never pass through the
cloud service.

## Threat Model for Hosted Mode

The case to stop: User A gets User B to install User A's app. Two risks:

- **B's agent is hijacked.** Text in A's repo instructs B's agent to use any key it can reach.
  A hijacked agent on B's laptop can read every `.env.astrodock` on that disk, and an agent
  with browser control can click buttons. The factor prompt on each approval is the control
  that holds: a passkey needs a person's touch, and a TOTP code comes from the person's phone.
  TOTP is weaker here: a code can be passed along, so a hijacked agent can ask the user for
  one in chat.
- **A's code is hostile once it runs on B's instance.** It gets its own database, bucket, OS
  user and env (see `SECURITY.md`). What it can still do, as of 2026-11-02:
  - send its own data and its users' data anywhere (no outbound limits)
  - use all of the box's CPU and memory (no caps on Node or Docker apps)
  - show a fake sign-in page to its visitors
  - as a Node app, it runs inside the runner container, which holds the Docker socket and the
    GitHub PAT, separated only by Unix users

The VM boundary separates customers from each other. Everything in this section is about one
customer's instance.

`SECURITY.md` states the single-trusted-operator model. Hosted mode adds untrusted app code
from third parties, so `SECURITY.md` needs a hosted-mode section before launch.

## Phase 1: Instance Work (Ships in the Open-Source Product)

| # | Item | Notes |
|---|---|---|
| 1.1 | Publish `@astrodock/cli` to npm | `npm view @astrodock/cli` returns 404 today. `npx` depends on it |
| 1.2 | `astrodock login` | Device-style flow: start session, open browser, poll, write `.env.astrodock`, add to `.gitignore` |
| 1.3 | Login sessions on the instance | Start, poll and complete endpoints. Single-use, short-lived codes |
| 1.4 | Approval page | Shows the repo's git remote and what `app.json` asks for (database, storage, env names, who can sign in). App key or account key. Creates the app if it is new |
| 1.5 | Factor on every approval | Not the 15-minute re-auth window (`REAUTH_WINDOW_MS`): each approval asks for its own factor. Passkey offered first |
| 1.6 | Approval requests for agent keys | Today `requireRecentAuth` lets every key through (`sessions.js:109`). Actions beyond one app return an approval URL instead of running: create app, grant existing end users access, add a domain, issue an account key |
| 1.7 | Account key preset | Deployer scopes across all apps. `users:write`, domains and the sensitive group go through approval requests (1.6) |
| 1.8 | Per-app CPU and memory caps | Docker apps: `--memory` and `--cpus` on `docker run` (`deploy-worker.js:425`). Node apps: see decision D1 |
| 1.9 | Per-app outbound traffic metering | Bytes out per app, shown in the instance admin and reported to the cloud service |
| 1.10 | Passkey encouragement | Passkey is the default choice at account creation. A notice in the account page while only TOTP is set |
| 1.11 | Cookie and origin check | Confirm no app subdomain can read or set cookies used by the admin or auth hosts. The hosted-login cookie is host-only (`oauth.js:121`); check the rest |

## Phase 2: Instance Image, Provisioning and Pool

| # | Item | Notes |
|---|---|---|
| 2.1 | Droplet image | Snapshot with Docker and the stack images pulled at a pinned `ASTRODOCK_VERSION` |
| 2.2 | Pool boot | Cloud-init runs `setup.sh --setup-token <cloud-generated>`. Each droplet generates its own secrets. The instance waits in first-run setup |
| 2.3 | Provisioning claim endpoint | Today `POST /setup/claim` requires a password (`setup.js:161`). Add a mode, gated by the setup token, that sets the domain and creates the owner by email with no password. The owner adds a passkey or TOTP on first visit |
| 2.4 | DNS and certificates | Provisioner creates `*.<customer>.<domain>` records through the DO API. Certificate approach: see decision D2 |
| 2.5 | Droplet firewall | DO Cloud Firewall on every droplet: inbound 80 and 443 only, outbound SMTP (25) blocked |
| 2.6 | Pool manager | Refill on assignment. Min, max and auto-sizing from the recent sign-up rate. Rebuild pool droplets after a release |
| 2.7 | Manual assignment | Fleet admin action to assign a pool droplet to an email, for testing before billing exists |

## Phase 3: Accounts, Billing and Signup

| # | Item | Notes |
|---|---|---|
| 3.1 | Cloud service accounts | Email plus passkey (default) or TOTP |
| 3.2 | `/start` page | Plans, price, refund terms, account creation, then Stripe Checkout |
| 3.3 | Stripe | Checkout in subscription mode, webhooks, Radar on |
| 3.4 | One instance per card | Reject a card fingerprint that already has an instance |
| 3.5 | Self-serve cancel and refund | Full refund within 14 days of signup. After that, cancel at period end |
| 3.6 | Transactional email | Signup confirmation, receipt, cancel and refund notices |
| 3.7 | End-to-end test | `npx @astrodock/cli login` from an empty repo with no account to a deployed app |

## Phase 4: Fleet Operations and Lifecycle

| # | Item | Notes |
|---|---|---|
| 4.1 | Fleet admin | Pool status (ready, booting, failed, image version), sign-ups per day and week, instances per plan, droplets used against the DO account limit |
| 4.2 | Upgrades | Roll a version across instances in batches, using the existing self-update worker (`self-update.js`) |
| 4.3 | Health rollup | Per-instance health from the instance health endpoint |
| 4.4 | Off-box backups | `backup.sh` output pushed to DO Spaces per customer |
| 4.5 | Abuse signals | Outbound bandwidth per droplet and per app, with alerts. Suspend action |
| 4.6 | Plan changes | Upgrade through DO resize. CPU and RAM resize requires a power-off; a disk resize cannot be reversed |
| 4.7 | Lifecycle | Cancel, suspend on failed payment, data export, then delete droplet, DNS records and backups |

## Phase 5: Launch

| # | Item | Notes |
|---|---|---|
| 5.1 | `SECURITY.md` hosted-mode section | The threat model above, with what is enforced and what is not |
| 5.2 | Terms of service, acceptable use policy, privacy policy | The acceptable use policy is the basis for suspending abusive instances |
| 5.3 | Agent discovery | `llms.txt` and an agent getting-started page on astrodock.ai. Neither found in `astrodock-site` |
| 5.4 | DO droplet limit | Raise the account limit with DO ahead of demand |

## Open Decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | CPU and memory caps for Node apps. PM2 cannot cap CPU, and `max_memory_restart` only restarts. All Node apps share one runner container | Run each Node buildpack app in its own container. It keeps the buildpack (no Dockerfile needed), gives real caps and per-app traffic counts, and takes app code out of the container that holds the Docker socket and PAT. This changes the "PM2 inside a runner" locked decision |
| D2 | Certificates. One cert per app hostname under one shared domain hits Let's Encrypt's 50 certificates per registered domain per week | A separate customer domain on the Public Suffix List, which also separates cookies between customers. The alternative is one wildcard cert per customer via DNS-01, which needs a Caddy build with the DigitalOcean DNS module |
| D3 | Customer domain | A new domain, separate from astrodock.ai |
| D4 | Where the cloud service code lives | A separate private repo. Astrodock stays open source |
| D5 | Cloud service stack | An app on its own dedicated Astrodock instance, which gives it hosted login, a database and deploys |
| D6 | Plans and prices | Measure the stack's idle memory on the live instance first. It sets the smallest droplet that can be sold |
| D7 | Data retention after cancel | A fixed export window, then hard delete. Length is yours to set |
| D8 | DO region | One region at launch |
