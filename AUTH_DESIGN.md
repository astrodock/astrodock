# Auth, identity & agent permissions — design

Status: **proposed**, not built. Supersedes the auth sections of `BUILD_PLAN.md` once accepted.
Gates `v0.1.0`: the app-facing contract must be settled before that version implies stability.

## Why

Three problems, each independently worth fixing, which share one solution.

**1. Every app sees its users' passwords.** `/verify` takes `{email, password, appId, appSecret}` —
the app's server receives the plaintext password and forwards it. A compromised app, or one that
logs request bodies, captures credentials for every user who signs in. Those same credentials work
on any other app that user can reach.

**2. That gets worse when operators are also end users.** `/verify` and `/admin/login` check the same
`password_hash` on the same row. An operator who is also an end user of one of their own apps hands
that app a credential that opens the dashboard. This is the expected case, not an edge one.

**3. End-user MFA is unbuildable on credential forwarding.** There is nowhere to put a second
factor: the app cannot prompt for one it does not own, and the platform never meets the user.
Operator MFA works today only because the dashboard login is already platform-hosted — which is the
proof of the point.

All three dissolve if the platform, not the app, collects credentials.

## Identity model

**One identity, two independent capabilities.** The same person may be an operator *and* an end user
of their own apps; splitting the tables would make that impossible to express.

```
users
  operator_role : null | owner | admin | operator | viewer   → dashboard access
  app_access    : string[]                                    → which apps they may sign into
```

- `null` role, non-empty `app_access` → pure end user
- `owner`, empty `app_access` → pure operator
- both → both

The two checks stay strictly independent: `/admin/login` requires a non-null `operator_role`;
app sign-in requires `app_access.includes(appId)` and **does not consider the operator role at all**.
An owner with no `app_access` cannot sign into an app. That property is worth preserving — it is why
this is two fields rather than a role hierarchy.

**End users have no roles.** Astrodock answers "is this person allowed into this app" and nothing
else. Apps needing finer permissions own that themselves; `/verify` already returns `userId`, which
is enough to key an app's own tables. Deliberately not building a profile or metadata store — that
is a different product, and it would create a second home for user data with no clear owner.

### Operator roles

| Role | Can |
|---|---|
| `owner` | Everything, including key management and destructive operations. At least one must exist and cannot be removed or demoted by anyone but another owner. |
| `admin` | Everything except transferring ownership |
| `operator` | Apps, deploys, config, runtime, logs — no user or key management |
| `viewer` | Read-only, including the audit trail |

Same vocabulary as the agent scopes below, so "what can this person do" and "what can this key do"
are one concept rather than two.

## Authentication factors

An account may hold any combination of:

- **Password** — bcrypt, as today. Now **nullable**: an account may have none.
- **Passkeys** (WebAuthn) — zero or more. May *replace* the password entirely.
- **TOTP** — RFC 6238, one enrolled authenticator.
- **Recovery codes** — ten single-use codes, hashed at rest. Mandatory whenever any second factor
  or passwordless mode is enabled.

### The invariant that matters

**An account must always retain at least one usable primary factor.** Recovery codes do not count —
they are break-glass, single-use, and exhaustible. Concretely:

- Cannot remove the last passkey while `password_hash` is null
- Cannot clear the password while no passkey exists
- Cannot demote or deactivate the last `owner`

Every one of these is a lockout with no remedy short of database surgery, so they are enforced in the
data layer, not only in the UI.

### Passkeys

- **Discoverable credentials (resident keys) with user verification required.** Both are needed for
  passwordless: the authenticator must be able to identify the user without a username, and must
  confirm presence *and* identity rather than mere touch.
- Attestation: `none`. We are not auditing authenticator provenance, and requesting attestation
  costs privacy and compatibility for nothing.
- Store: credential ID, public key, signature counter, transports, a user-supplied label, created
  and last-used timestamps.
- **Signature counter regression is rejected** — a counter going backwards indicates a cloned
  authenticator. Some authenticators always report zero; that case is allowed and recorded.

**RP ID is the admin host** (`admin.<base-domain>`), not the base domain. All ceremonies happen on
the hosted login page, which lives there. Scoping to the base domain would let every app subdomain
exercise passkeys, which nothing needs and which widens the credential's reach for free.

> **Interaction with runtime domain changes.** The base domain is now settable at runtime, and the
> RP ID derives from it. **Changing the base domain invalidates every enrolled passkey**, because
> WebAuthn credentials are bound to the RP ID that created them. This must be surfaced loudly at the
> point of change, and the domain-change flow needs a re-enrolment path. This is a real cost of the
> runtime-domain feature that was not visible when that decision was made.

### TOTP

- SHA-1, 6 digits, 30-second step. Not a security preference — it is what every authenticator app
  interoperates with.
- Secret encrypted at rest with the existing `lib/crypto` AES-256-GCM path. Unlike passkeys, TOTP
  seeds are a real secret in the database; treat them like app secrets.
- Enrolment requires one valid code before the factor is switched on, so nobody locks themselves out
  by mis-scanning a QR.
- Verification accepts ±1 step for clock skew, and **records the last accepted step to reject
  replay** — without that, a phished code is reusable for its whole window.

### Why both

Passkeys are phishing-resistant, leak nothing useful from a database dump, and are the better daily
experience. TOTP earns its place for the cases passkeys handle badly: a device-bound authenticator
that cannot travel, a locked-down corporate machine, a user whose password manager does not sync.
Offering both costs one extra verification path and removes the main reason someone would turn MFA
off.

## Hosted login

The app stops handling credentials.

```
1. app  →  302  /authorize?app_id=&redirect_uri=&state=&nonce=
2. platform validates app_id, and redirect_uri against that app's allowlist
3. platform serves its own login page on its own origin  (password / passkey, + second factor)
4. platform checks app_access.includes(app_id)
5. platform  →  302  redirect_uri?code=&state=
6. app server  →  POST /token {code, app_id, app_secret}      (server-to-server)
7. platform  →  {userId, email, name}
8. app mints its own session, exactly as it does today
```

Step 8 is unchanged, which keeps the "your app owns its sessions" property that makes the current
model easy to reason about.

### Security requirements

These are the parts that go wrong in hand-rolled implementations:

- **`redirect_uri` matched exactly against a per-app allowlist.** Not prefix, not wildcard. Prefix
  matching is how codes get stolen. Allowlist entries are managed alongside the app.
- **Codes are single-use, ≤60s, and bound to `app_id` + `redirect_uri`.** Stored in a table rather
  than signed-and-stateless, because single-use is then trivially enforceable rather than requiring
  a replay cache anyway.
- **Exchange requires `app_secret` and is server-to-server only.** No user data ever travels in a
  redirect URL.
- **`state` is echoed unmodified**; the app is responsible for comparing it. Documented in
  `AGENTS.md` as a requirement, not a suggestion.
- **Rate limits** on `/authorize`, `/token`, and every credential-verifying endpoint.
- Platform session cookie scoped to the admin host, `HttpOnly`, `Secure`, `SameSite=Lax`.

### What this buys beyond security

One platform session means signing into one app signs you into all of them — **SSO across your apps,
free**, which credential forwarding can never provide. This is a feature, not a consolation.

### `/verify` stays

Kept, working, and documented as **legacy**. It is the right fit for scripts and non-browser clients,
and removing it would break every existing app for no benefit. New apps get the redirect flow;
`app.json` gains `auth.mode: "platform"` (hosted) alongside the existing behaviour.

The plaintext-password caveat is documented against `/verify` explicitly, rather than left implicit.

## Sessions

Dashboard sessions are currently an 8-hour JWT with **no revocation** — a compromised operator
session cannot be killed. Add a `sessions` table: device label, IP, created, last-seen, revoked-at.
Operators can list and revoke their own; owners and admins can revoke anyone's.

This also supplies part of the "full logs of what users do" requirement: sign-ins become first-class
records rather than log lines.

### Step-up authentication

Re-prompt for a factor, regardless of session age, before:

- changing authentication methods, or viewing/regenerating recovery codes
- minting or revoking access keys
- deleting an app with `?purge=true`
- changing the base domain or TLS mode
- changing another operator's role

## Agent keys & scopes

Today there are two scopes, `deploy` and `pages`. `deploy` covers every route in `admin-apps.js`,
including app deletion with purge and — where the terminal is enabled — arbitrary command execution.
A key handed out "just to deploy" can destroy data and run code.

Replace with `resource:action`:

```
apps:read      apps:write      apps:delete
deploys:write  runtime:write   logs:read
env:read       env:write       domains:write
pages:read     pages:write
users:read     users:write     events:read
settings:read  settings:write  backups:write
platform:write tokens:write    exec
```

**Presets**, because nobody hand-picks eighteen checkboxes:

- **Deployer** — `apps:read/write`, `deploys:write`, `env:*`, `runtime:write`, `logs:read`, `domains:write`
- **Operator** — Deployer + `users:*`, `events:read`, `settings:*`, `backups:write`, `pages:*`
- **Platform manager** — everything except `exec` and `tokens:write`
- **Read-only** — every `:read`

### Rules

1. **`apps:delete` is separate from `apps:write`.** It purges databases and object storage.
2. **`exec` never appears in a preset.** Per-key opt-in, app-scoped, and still gated by the global
   `ASTRODOCK_ENABLE_TERMINAL`. Two independent switches.
3. **Keys expire.** `expires_at`, default 90 days, "never" only by explicit choice. With the existing
   `last_used_at`, stale keys become visible and killable.
4. **`app_scope` is unchanged** and applies to every app-scoped resource.

### Delegation

An agent may mint keys — that is how a platform-managing agent gives a project its own deploy key.
The constraints:

- Requires `tokens:write`
- New key's scopes must be a **proper subset** of the minting key's
- New key's `app_scope` ⊆ minter's; expiry ≤ minter's
- **`tokens:write` is never grantable by a key.** Only a human can create a key that mints keys.
  This terminates delegation chains at depth one and makes "never the same level or higher"
  structural rather than a policy someone has to remember.

### Provenance

Every key records `authorized_by_user_id` — the human at the root of the chain — and
`created_by_token_id`. A minted key inherits the same root human. Every audit event records the
acting token id, a snapshot of its scopes at time of use, and that root human, so "who authorised
this" survives renames and revocations.

### End-user management by agents

`users:write` allows managing end users, but never:

- an operator with role `owner`
- the user the acting key is authorised under
- granting or changing any `operator_role`

Agents manage end users. Humans manage operators.

### Secrets stay unreadable

No scope returns a secret value, for keys or humans — `serializeEnvVar` already masks them and that
holds. For debugging, add a **verification** endpoint: "does the stored value for KEY match this
string" answers the real question without disclosure.

## `exec` — to be rebuilt, not merely gated

As implemented, `GET /:slug/exec` spawns `sh -c` **in the API container**, which loads the full
`.env`: the secret-encryption key that decrypts every app's secrets, the admin JWT signing secret,
the runner token, and the database password. It is a full platform compromise.

It also does not work. The API container mounts only `static` and `caddylogs`; `/data/apps` lives on
the runner, so the working directory does not exist there. The route predates the runner split and
was never moved.

Replacement, in order of preference:

1. **Structured operations** covering what a shell is actually used for: read a file, list a
   directory, show runtime env (masked), report process and resource state, and **run a command
   declared in `app.json`**. That last distinction is the important one — *committed* commands are
   code a human reviewed; *composed* commands are strings assembled from log output, which may have
   been authored by an attacker. Same action, different trust.
2. **If raw exec survives**, it moves to the runner and runs inside the app's own process or
   container, never the API container, so a per-app key has a per-app blast radius.
3. **Human-only by default.** Agents get structured operations. Raw exec for an agent is a
   time-boxed, human-approved elevation.
4. Command and exit code recorded as audit events, not just deploy-log text.

This is also the containment story for prompt injection. An agent debugging an app reads build logs,
runtime logs, access logs and repository contents — all attacker-influenceable. Scope minimisation,
`app_scope`, committed-vs-composed, no secret reads, and provenance in the audit trail all limit what
an injected agent can accomplish **without assuming the agent is trustworthy**. That matters more
here than in most products, because operators bring their own agents.

## Data model changes

```
users
  + operator_role        text null            -- replaces is_admin
  ~ password_hash        text NULL            -- was NOT NULL
  + totp_secret          text null            -- AES-GCM, via lib/crypto
  + totp_confirmed_at    timestamptz null
  + totp_last_step       bigint null          -- replay rejection
  + passwordless         boolean default false
  + last_login_at        timestamptz null

webauthn_credentials      user_id, credential_id, public_key, sign_count,
                          transports, label, created_at, last_used_at

recovery_codes            user_id, code_hash, used_at

sessions                  user_id, token_id, device, ip, created_at,
                          last_seen_at, revoked_at

authorization_codes       code_hash, app_id, user_id, redirect_uri,
                          expires_at, used_at

app_redirect_uris         app_id, uri                     -- exact-match allowlist

api_tokens
  + expires_at           timestamptz null
  + authorized_by_user_id uuid
  + created_by_token_id  uuid null
```

## Migration & rollout

1. `is_admin: true` → `operator_role: 'admin'`; the seeded first account becomes `owner`.
2. Existing scopes map forward: `deploy` → the Deployer preset, `pages` → `pages:*`. Old tokens keep
   working; the UI shows them as legacy until reissued.
3. `/verify` unchanged throughout.
4. Hosted login ships alongside it; the starter app and `AGENTS.md` move to the redirect flow.
5. MFA is opt-in per account, with a readiness nudge once HTTPS is live — **passkey enrolment cannot
   happen during first-run setup**, since WebAuthn requires HTTPS and setup runs over `http://<ip>`.

## Open questions

- **Sequencing against `v0.1.0`.** Hosted login gates it, since that version implies a stable app
  contract. MFA, scopes and roles are additive and could follow — but shipping "auth included" with
  no MFA at all invites the obvious question.
- **Should `viewer` see the audit trail?** It contains who-did-what across the platform. Currently
  assumed yes; arguably a separate grant.
- **MFA enforcement policy.** Can an owner require MFA for all operators? Probably yes, eventually,
  but it needs a "you will lock yourself out" guard.
- **Base-domain change vs passkeys.** Re-enrolment is the honest answer; whether to hard-block a
  domain change while passkeys exist, or warn and proceed, is undecided.
