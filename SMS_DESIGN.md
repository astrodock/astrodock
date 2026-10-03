# SMS as a platform service

**Status: proposal.** Nothing below is built.

The point is that an app never speaks to Twilio. It declares that it wants a
number, and gets one; it sends by calling the platform; inbound arrives as an
HTTP POST it can verify. Twilio credentials, number inventory, opt-outs and
compliance live in one place, as they already do for email.

This is not a new pattern. It is the pattern the platform already uses four
times.

| Existing resource | How it works | SMS equivalent |
|---|---|---|
| `auth: { mode: platform }` | platform hosts the credential surface; the app holds only `ASTRODOCK_APP_ID` + `ASTRODOCK_APP_SECRET` and calls `/verify` or `/token` | the app calls `POST /sms/send` with the same two values |
| `database: { mode: internal }` | platform provisions, injects a connection string | platform assigns a number, injects it as env |
| `custom_domains` | hostname → app, and Caddy routes by `Host` | `sms_numbers`: number → app, and the platform routes by `To` |
| GitHub webhooks (`routes/webhooks.js`) | HMAC over the raw body, per-app secret | the platform signs what it forwards to the app the same way |
| `lib/email-config.js` | provider + credential in `platform_settings`, encrypted, with env as a seed | `lib/sms-config.js`, same shape |

---

## The provider is Telnyx, behind an adapter

`lib/email-config.js` already holds a provider choice (`resend | smtp`) in
`platform_settings` with the credential encrypted and env as a seed.
`lib/sms-config.js` is the same shape with `telnyx` as the only implemented
value, and the seam left where a second would go. That is not hedging: it is what
makes the choice reversible in a day rather than a rewrite.

Telnyx over Twilio for two reasons that are not price. Its webhooks are signed
with Ed25519 over the payload, where Twilio's HMAC covers the full URL it thinks
it called and so has to be reconstructed behind Caddy. And node verifies Ed25519
with `crypto.verify` out of the box, so the dependency count stays at zero.

Twilio's advantage is that more people have debugged 10DLC registration with it.
If registration goes badly, that is the thing that will be missed.

**API shapes below should be checked against current Telnyx docs before
building.** They are from training data, not from a call made today.

```
POST /v2/messaging_profiles          one profile for the platform; holds the webhook URL
GET  /v2/available_phone_numbers     search by country and area code
POST /v2/number_orders               buy
POST /v2/messages                    send: { from, to, text }
```

One messaging profile, not one per app. The webhook lives on the profile, so a
single profile means a single inbound URL and the platform routes by the
receiving number — which is the whole point of the abstraction. Per-app profiles
would isolate 10DLC campaigns from each other and are worth revisiting if one
app's traffic ever threatens another's registration.

## Numbers are bought by the API, on issuance

Assigning a number to an app searches for one and orders it, rather than asking
an operator to paste one they bought by hand. Which means a button press spends
money, so:

- the dashboard shows the number and its monthly cost and asks before ordering
- a cap in `platform_settings` bounds how many numbers an install will ever buy,
  defaulting low, so a bug in a loop cannot order fifty
- releasing a number in the dashboard releases it at Telnyx too, or the rental
  continues for something nothing is using
- every order and release is an `audit` event, because it is a charge

---

## One number per app, not a shared one

A shared number cannot be routed. Email solves this with distinct addresses
(`trips@`, `plate@`); a text carries no app selector, and every workaround is
worse than the cost of a second number:

| Approach | Why not |
|---|---|
| Keyword prefix (`valise: add a flight`) | Nobody does this twice |
| Route by most recent conversation | Silently files your flight in the wrong app |
| Route by each person's default app | One person, one app, permanently |

So the number *is* the address, exactly as a hostname is. A number maps to one
app, and the platform owns the mapping.

The A2P 10DLC brand registration is per business and shared across campaigns, so
the expensive, slow part is paid once. Extra numbers after that are a rental.

---

## What an app declares

`app.json` gains a block beside `database` and `storage`
(`packages/schema/app.schema.json`):

```json
"sms": {
  "mode": "internal",
  "inboundPath": "/api/sms/inbound"
}
```

`mode` is `internal` or `none`, matching the other resources. `inboundPath` is
where the platform POSTs a received message; omit it and the app is send-only.

There is no `external` mode. An app that wants to run its own Twilio account can
simply not use this and set its own env, which is already true of everything else.

## What the platform injects

Added to the auth section of `lib/env-compute.js`:

```
ASTRODOCK_SMS_NUMBER     +15551234567        the number assigned to this app
ASTRODOCK_SMS_SEND_URL   http://api:3100/sms/send
ASTRODOCK_SMS_SECRET     <per-app>           verifies inbound forwards
```

`ASTRODOCK_SMS_SEND_URL` is the internal service address, like
`ASTRODOCK_AUTH_URL`: server-to-server, never leaves the box.

`ASTRODOCK_SMS_SECRET` is a dedicated per-app secret rather than a reuse of
`appSecret`, for the same reason `appJwtSecret` and `webhookSecret` are already
separate: rotating the thing that authenticates outbound should not invalidate
the thing that verifies inbound.

---

## The three endpoints

### `POST /sms/send` — an app sends

```json
{ "appId": "valise", "appSecret": "…", "to": "+15551234567", "body": "…" }
```

Authenticated exactly as `/verify` is, because every platform-auth app already
holds those two values and no new credential has to be distributed.

Refuses, with a reason the app can show a person:

- the app has no number assigned
- `to` is opted out (see below) — refused here rather than failing at Twilio
- the app is over its rate limit
- no SMS provider is configured on the platform

### `POST /sms/inbound/telnyx` — the provider delivers

Public by necessity. Verifies Telnyx's Ed25519 signature
(`telnyx-signature-ed25519` + `telnyx-timestamp`, over `timestamp|rawBody`,
against the portal's public key) and rejects a timestamp outside a few minutes.
Then reads `data.payload.to[0].phone_number`, finds the app in `sms_numbers`, and
POSTs to `https://<app host><inboundPath>`:

```json
{ "from": "+15559876543", "to": "+15551234567", "body": "…", "receivedAt": "…", "messageId": "…" }
```

signed `X-Astrodock-Signature: sha256=<hmac of the raw body with the app's sms secret>`.

Ed25519 is a real reason to prefer Telnyx here and not a detail. Twilio signs an
HMAC over the full URL it believes it called, which has to be reconstructed
behind a reverse proxy or verification fails — and Caddy sits in front of
everything on this box. A public-key signature over the payload does not care
what the proxy did to the URL.

A delivery the app rejects or cannot be reached for is logged and retried a small
number of times. It is not queued indefinitely: a text that arrives an hour late
is worse than one that never arrives.

**Who is allowed to text it is the app's decision, not the platform's.** The
platform knows nothing about an app's people. It forwards the sender's number and
the app matches it, which is exactly how Valise already treats inbound email with
its trusted-senders model. The platform's job is to rate-limit per sender so an
unknown number cannot run up a bill.

### `/admin/sms/*` — the operator

List numbers, assign one to an app, release one, see per-app message counts.
Mirrors `/admin/domains`.

---

## Tables

```
sms_numbers    id, number (unique), app_id, label, status, provider_id,
               monthly_cost, ordered_at, released_at, created_at
sms_messages   id, app_id, direction, from_number, to_number, body_length,
               provider_sid, status, error, created_at
sms_optouts    number, app_id, created_at        (STOP, per app)
```

`sms_messages` stores the **length** of a message, not its text. The platform does
not store email bodies either, and a central log of everyone's texts is a worse
thing to hold than the delivery problem it would help debug. Status, direction and
cost are what an operator actually needs.

`sms_optouts` exists because Twilio handles STOP at its end and the platform has
to know, or a later send fails at the vendor with nothing useful to say. Recorded
per app, since consent to one app is not consent to another.

---

## Notifications

`lib/notifications.js` already dispatches an event to a channel, with `email` and
`webhook` adapters at `// ── channel adapters`. SMS is a third adapter and a third
value for `notificationRules.channel`. Platform alerts over SMS fall out of that
for free; nothing else changes.

---

## Settled

- **Provider: Telnyx.** Behind an adapter, so a second one is config rather than
  a rewrite.
- **Numbers are bought through the API** when a number is issued to an app, with
  a confirmation, a cap, and an audit event per order.
- **One number per app.** A shared number cannot be routed; see above.

## Not a platform question

Whether a text carries the same authority as a web session, or a lower tier the
way inbound email already does in Valise (loyalty numbers masked,
`remove_expense` refused), is Valise's policy and not the platform's. The
platform delivers a message and says which number it came from. What that is
allowed to *do* belongs to the app, and this design deliberately does not answer
it.

## Open

- **Toll-free or 10DLC.** Affects how long a number takes to become usable, not
  what gets built. 10DLC needs a brand and a campaign; toll-free needs
  verification and no campaign paperwork.
