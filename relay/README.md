# Astrodock Push Relay

Sends push notifications from Astrodock servers to phones running the Astrodock
mobile app. Apple and Google only accept pushes signed with the app publisher's
credentials, which a self-hosted server does not have, so every server sends
through this relay. The relay never sees notification text: each server
encrypts the notification to the device, and the phone decrypts it.

The API is specified in `MOBILE_DESIGN.md`, section 7:

| Route | Purpose |
|---|---|
| `POST /v1/servers` | A server registers and gets `serverId` and `serverSecret` |
| `POST /v1/subscriptions` | A device registers its APNs or FCM token for one server and gets a `handle` |
| `DELETE /v1/subscriptions/:handle` | A device stops pushes to a handle |
| `POST /v1/push` | A server sends an encrypted envelope to a handle (`Authorization: Bearer rss_...`) |
| `GET /health` | `{ status, apns, fcm }` |

## Environment

| Variable | Secret | Purpose |
|---|---|---|
| `RELAY_DATABASE_URL` | yes | Postgres URL. Falls back to `ASTRODOCK_DATABASE_URL`, which Astrodock sets for an app with an internal database. |
| `ASTRODOCK_PORT` / `PORT` | no | Port to listen on (default 3000). |
| `RELAY_APNS_KEY` | yes | Contents of the APNs `.p8` key. |
| `RELAY_APNS_KEY_ID` | no | The key's Key ID. |
| `RELAY_APNS_TEAM_ID` | no | Your Apple Developer Team ID. |
| `RELAY_APNS_TOPIC` | no | The mobile app's bundle id, e.g. `ai.astrodock.mobile`. |
| `RELAY_FCM_SERVICE_ACCOUNT` | yes | The Firebase service account JSON. |
| `RELAY_REGISTRATION` | no | `code` (default) or `open`. |
| `RELAY_REGISTRATION_CODE` | yes | With `code`, servers must send this to register. Unset means registration is closed. |
| `RELAY_TRUST_PROXY` | no | Host name or IP of the reverse proxy allowed to set `X-Forwarded-For`, for per-IP rate limits. `caddy` on Astrodock. Unset means the socket address is used. |

iOS push is on when all four `RELAY_APNS_*` values are set and the key reads.
Android push is on when the service account reads. A platform that is off
answers 503 to pushes for it; the other platform keeps working.

`RELAY_APNS_HOST`, `RELAY_FCM_TOKEN_URL` and `RELAY_FCM_SEND_URL` point the
relay at fake providers. They are for tests only.

## Running as an Astrodock App

`app.json` deploys the relay as an Astrodock app: slug `push-relay`, subdomain
`push`, public auth, internal database, and `repoPath: relay` (it deploys from
this repository). It uses the Docker runtime (`Dockerfile`) because Caddy
proxies every path to a Docker app, while a Node buildpack app only gets
`/api/*`. The tables are created on first start.

```bash
cd relay
astrodock apply
astrodock set-secret RELAY_APNS_KEY < AuthKey_ABC123DEFG.p8
astrodock set-secret RELAY_APNS_KEY_ID ABC123DEFG
astrodock set-secret RELAY_APNS_TEAM_ID TEAM123456
astrodock set-secret RELAY_APNS_TOPIC ai.astrodock.mobile
astrodock set-secret RELAY_FCM_SERVICE_ACCOUNT < service-account.json
astrodock set-secret RELAY_REGISTRATION_CODE "$(openssl rand -hex 16)"
astrodock deploy:watch
```

The Docker runtime writes env values to a one-line env file, so line breaks in
the `.p8` key become spaces. The relay rebuilds the key from that.

To run it outside Astrodock: `npm ci && RELAY_DATABASE_URL=postgres://... npm start`.

## The APNs Key

1. In Apple Developer, open Certificates, Identifiers & Profiles › Keys and add
   a new key.
2. Name it, tick Apple Push Notifications service (APNs), and choose Sandbox &
   Production if asked for an environment.
3. Register it and download the `.p8` file. Apple lets you download it once.
4. The Key ID is on the key's page. The Team ID is in Membership details (also
   shown at the top right of the developer site).
5. The app's identifier (the bundle id) needs the Push Notifications
   capability, under Identifiers.

One key signs pushes for both the sandbox (development builds) and production
(TestFlight and App Store) hosts. Each subscription says which one it uses.

## The FCM Service Account

1. In the Firebase console, open the project that holds the Android app (the
   same project the mobile build's `google-services.json` comes from).
2. Project settings › Service accounts › Generate new private key. This
   downloads a JSON file.
3. Set the whole file as `RELAY_FCM_SERVICE_ACCOUNT`.
4. The Firebase Cloud Messaging API (V1) must be enabled for the project
   (Project settings › Cloud Messaging). It is on by default in new projects.

## Tests

`npm test` runs everything in-process: the relay on port 0 with an in-memory
store, a fake APNs (plain-text HTTP/2) and a fake FCM. The Postgres store tests
run only when `RELAY_TEST_DATABASE_URL` is set; they create the two tables if
missing and delete only the rows they add.
