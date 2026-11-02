# Mobile App, Notifications and Push Relay

A native app (Expo) that signs in to one or more Astrodock servers, lists the
apps a person can use on each, opens each app in a WebView, and receives
notifications. Three parts, each in this repository:

| Part | Folder | Runs where |
|---|---|---|
| Control plane changes | `apps/control-plane`, `apps/admin`, `packages/auth-client` | Every Astrodock server |
| Push relay | `relay/` (own `package.json` and lockfile, not an npm workspace) | One service the mobile app's publisher runs, e.g. `push.astrodock.ai` |
| Mobile app | `mobile/` (own `package.json` and lockfile, not an npm workspace) | iOS (TestFlight first), Android |

`relay/` and `mobile/` stay out of the root workspaces so `npm ci` for the
platform and its Docker images never installs Expo or React Native.

Apple accepts pushes for an app only when they are signed with that app's APNs
key. A self-hosted server does not have the key, so every server sends through
the relay. The relay never sees notification text: the server encrypts each
notification to the device, and the phone decrypts it.

## 1. Discovery

`GET https://<auth host>/.well-known/astrodock.json` (no auth, CORS `*`):

```json
{
  "astrodock": 1,
  "name": "Astrodock",
  "version": "0.0.31",
  "baseDomain": "astrodock.ai",
  "authUrl": "https://auth.astrodock.ai",
  "mobile": { "enabled": true },
  "push": { "relayUrl": "https://push.astrodock.ai", "serverId": "srv_..." }
}
```

- `name` is the platform name setting if there is one, else "Astrodock".
- `push` is `null` until the server is registered with a relay.
- `mobile.enabled` is the `mobile.enabled` setting (default true). When false,
  every `/mobile/*` route answers 404.

The app takes what the person types (`astrodock.ai`, `auth.astrodock.ai`,
`admin.astrodock.ai`, or a full URL) and tries, in order:
`https://<input>/.well-known/astrodock.json`, then
`https://auth.<input>/.well-known/astrodock.json`. A leading `admin.` is
replaced with `auth.` first. The server's identity from then on is `authUrl`.

## 2. Mobile Sign-In (PKCE)

The app is a public client: it holds no secret. It signs in with an
authorization code bound to a PKCE verifier.

1. The app opens the system browser sheet (`expo-web-browser`
   `openAuthSessionAsync`, which is `ASWebAuthenticationSession` on iOS) at
   `GET <authUrl>/mobile/authorize?code_challenge=<S256>&code_challenge_method=S256&state=<random>&redirect_uri=astrodock://auth`.
2. The server checks `redirect_uri` is exactly `astrodock://auth`.
   - If the platform session cookie (`ad_user_session`) names an active user,
     it issues a code and redirects to
     `astrodock://auth?code=<code>&state=<state>`.
   - Otherwise it shows the hosted sign-in page (password, passkey, Google,
     two-factor: whatever `/authorize` offers). On success it sets the platform
     session and finishes as above. Reuse the existing sign-in page and login
     handler; do not build a second form.
   - `prompt=login` forces the form, as on `/authorize`.
3. `POST <authUrl>/mobile/token`, JSON
   `{ code, code_verifier, device: { name, platform: "ios"|"android", appVersion } }`
   → `{ deviceId, deviceToken, user: { id, email, name } }`.
   - The code is single-use, expires after 60 seconds, is stored hashed, and is
     redeemed only with the verifier whose S256 hash matches the challenge.
   - `deviceToken` is `adt_` plus 32 random bytes (base64url). Stored as a
     SHA-256 hash. It expires after 90 days without use; each use extends it.

Every `/mobile/*` route below takes `Authorization: Bearer adt_...`. A token
that is unknown, revoked, expired, or whose user is inactive gets 401
`{ "error": "Sign in again." }`.

## 3. Opening an App in the WebView

The WebView needs the platform session cookie on the auth host so each app's
own sign-in (`/authorize`) completes with no form.

1. `POST /mobile/ticket` `{ app: "<slug>" }` → `{ url }`, where `url` is
   `<authUrl>/mobile/open?ticket=<ticket>`. The ticket is single-use, expires
   after 60 seconds, is stored hashed, and is bound to the device and the app.
2. The WebView loads `url`. The server redeems the ticket, sets
   `ad_user_session` for the device's user, and redirects (303) the way
   `POST /launch` does:
   - an app with `authMode` `public` → the app's URL
   - otherwise → `${appUrl(app)}${app.authLoginPath}`
3. Optional `path` on the ticket request (`{ app, path: "/tasks/12" }`): stored
   with the ticket and passed to the app as `?next=<path>` on its login path.
   Must start with `/` and not `//`. Apps that ignore `next` land on their home
   page.
4. The ticket is refused (403) if the user no longer has access to the app.

## 4. App List

`GET /mobile/apps` →

```json
{
  "user": { "id": "...", "email": "...", "name": "..." },
  "apps": [
    { "slug": "assistant", "name": "Assistant", "description": "",
      "url": "https://assistant.astrodock.ai", "logoUrl": "", "brandColor": "",
      "authMode": "platform" }
  ],
  "admin": { "url": "https://admin.astrodock.ai" }
}
```

- `apps`: provisioned apps in the user's `appAccess`, by name.
- `admin`: present only when the user has an operator role.

## 5. Devices

`mobile_devices` table: `id`, `user_id`, `name`, `platform`, `app_version`,
`token_hash`, `push_handle`, `push_public_key`, `push_environment`,
`created_at`, `last_seen_at`, `expires_at`, `revoked_at`.

- `GET /mobile/device` → this device's record (no hashes).
- `DELETE /mobile/device` → revokes this device (the app's Sign Out).
- `PUT /mobile/push` `{ handle, publicKey, environment: "sandbox"|"production" }`
  stores the relay handle (section 7) and the device's X25519 public key
  (32 bytes, base64). The key is optional: Android sends none and is pushed the
  generic text. `DELETE /mobile/push` clears them.
- The hosted Account page (`/account`) lists the person's devices with a Revoke
  button. Admin › Users › a user lists theirs too, with Revoke.

## 6. Notifications

### Inbox

`user_notifications` table: `id`, `user_id`, `app_id` (null for platform
notices), `title`, `body`, `path`, `created_at`, `read_at`.

- `GET /mobile/notifications?before=<ISO>&limit=50` → newest first:
  `{ notifications: [{ id, app: { slug, name } | null, title, body, path, createdAt, readAt }], unread }`.
- `POST /mobile/notifications/:id/read`, `POST /mobile/notifications/read-all`.
- Kept 90 days, then deleted (the existing cleanup jobs are the place for this).

### Sending: the Notify API

`POST /notify` on the control plane, called by an app's server at its internal
`ASTRODOCK_AUTH_URL` (no Caddy route needed):

```json
{ "app_id": "assistant", "app_secret": "...", "user_id": "<uuid>",
  "title": "Task Due", "body": "Call the bank", "path": "/tasks/12" }
```

- Auth: the app secret, exactly as `POST /token` checks it.
- `user_id` or `email`. The user must have access to the app (403 otherwise).
- `title` up to 120 characters, `body` up to 1000, `path` as in section 3.
- Rate limit: 60 per app per user per hour (429 beyond).
- Stores the inbox row, answers `{ id }`, then pushes to each of the user's
  devices with a push handle. A push failure never fails the request.
- `@astrodock/auth-client` gets `notify({ userId | email, title, body, path })`
  and its type.

### Operator Alerts

`lib/notifications.js` gains a third channel, `push`. Target:
`{ users: "operators" }` (every user with an operator role) or
`{ users: ["<uuid>", ...] }`. A push alert is an inbox row with `app_id` null
and `path` null; the message is the event's message. The admin UI's rule
editor offers the channel.

### Encryption

For each device, the server encrypts the notification:

- Plaintext (UTF-8 JSON):
  `{ "id", "t": title, "b": body, "a": appSlug|null, "an": appName|null, "p": path|null }`
- Ephemeral X25519 key pair; shared secret with the device's public key.
- Key: HKDF-SHA256, salt = the 32-byte ephemeral public key, info =
  `"astrodock-push-v1"`, 32 bytes.
- AES-256-GCM, 12-byte random nonce, no additional data.
- Envelope: `{ "v": 1, "e": b64(ephemeralPublicKey), "n": b64(nonce), "c": b64(ciphertext || 16-byte tag) }`.

The same scheme is implemented in Node (`crypto`: `generateKeyPairSync('x25519')`,
`diffieHellman`, `hkdfSync`, `createCipheriv('aes-256-gcm')`) and in Swift
(CryptoKit: `Curve25519.KeyAgreement`, `HKDF<SHA256>`, `AES.GCM`). One test
vector (fixed keys and nonce → fixed envelope) is the reference for both:
`apps/control-plane/test/fixtures/push-vector.json`, written by the control
plane's encryption code. The mobile repo copies it and checks its Swift
decryption against it.

## 7. Push Relay

A small Node service (`relay/`). Express-free is fine; `node:http` + `postgres`.
Postgres through `RELAY_DATABASE_URL` or `ASTRODOCK_DATABASE_URL`, so it can run
as an Astrodock app itself (it carries an `app.json`: auth `public`, database
`internal`, subdomain `push`).

### Server registration

- `POST /v1/servers` `{ name, url, registrationCode? }` → `{ serverId, serverSecret }`.
  `serverId` is `srv_` + 16 random bytes; `serverSecret` is `rss_` + 32 random
  bytes, stored hashed. `RELAY_REGISTRATION=open|code` (default `code`); with
  `code`, `registrationCode` must equal `RELAY_REGISTRATION_CODE`.
- The control plane registers itself from Admin › Settings › Mobile: relay URL
  (default `https://push.astrodock.ai`), registration code, Register button.
  It stores `push.relay_url`, `push.server_id`, and `push.server_secret`
  (a secret setting).

### Device subscriptions

The device registers its push token with the relay directly, per server, so a
server never holds a raw APNs or FCM token and cannot push to a device that did
not sign in to it.

- `POST /v1/subscriptions` `{ serverId, platform: "ios"|"android", environment: "sandbox"|"production", token }`
  → `{ handle }`. `handle` is `sub_` + 16 random bytes. Re-subscribing the same
  (server, token) returns the same handle. Rate limited by IP.
- `DELETE /v1/subscriptions/:handle` (no auth: knowing the handle is the
  authority, and deleting only stops pushes).

### Sending

`POST /v1/push`, `Authorization: Bearer rss_...`:

```json
{ "handle": "sub_...", "envelope": { "v": 1, "e": "...", "n": "...", "c": "..." },
  "badge": 3, "collapseId": "optional" }
```

- `envelope` is optional. Without one the push carries only the generic text
  and `ad.s` (or `data.s`), and no `mutable-content`.
- 404 `{ "gone": true }` when the handle is unknown or belongs to another
  server. The control plane then clears that device's push fields.
- iOS: APNs HTTP/2 (`node:http2`), token auth (ES256 JWT from the `.p8` key,
  cached under 50 minutes). Payload:
  `{ "aps": { "alert": { "title": "New Notification", "body": "Open to read." }, "mutable-content": 1, "badge": badge, "sound": "default" }, "ad": { "s": serverId, "x": envelope } }`.
  `apns-push-type: alert`, `apns-topic: RELAY_APNS_TOPIC`. Sandbox host for
  `environment: sandbox`. APNs 410 or `BadDeviceToken` → delete the
  subscription and answer `{ gone: true }`.
- Android: FCM HTTP v1 with a service account (`RELAY_FCM_SERVICE_ACCOUNT`, JSON).
  Sends `notification: { title: "New Notification", body: "Open to read." }`
  plus `data: { s, x: JSON.stringify(envelope) }`. Android shows the generic
  text in v1; the app reads the real text from the inbox.
- Per-server rate limit: 600 pushes per minute.
- Env: `RELAY_APNS_KEY` (the .p8 contents), `RELAY_APNS_KEY_ID`,
  `RELAY_APNS_TEAM_ID`, `RELAY_APNS_TOPIC` (the bundle id),
  `RELAY_FCM_SERVICE_ACCOUNT`, `RELAY_REGISTRATION`, `RELAY_REGISTRATION_CODE`.
  A platform with no credentials answers 503 for that platform.
- `GET /health` → `{ status: "ok", apns: bool, fcm: bool }`.

## 8. Mobile App

Expo (latest SDK), TypeScript, Expo Router. Bundle id `ai.astrodock.mobile`
(set in `app.config.ts` from `APP_BUNDLE_ID` so a fork can change it).

### Screens

- **Add Server**: one field (domain), Continue → discovery → sign-in sheet.
- **Apps** (tab): apps grouped by server, each with its logo or initial, name and
  description. Pull to refresh. An Admin row for operators.
- **App** (pushed screen): full-screen WebView with a compact header (Back to
  Apps, app name, a menu with Reload, Open in Safari, Share Link). Swipe-back
  navigates inside the WebView when it can go back.
- **Inbox** (tab): notifications from every server, newest first, unread
  marked. Tap → mark read → open the app at `path`.
- **Settings** (tab): servers (Sign Out, Remove), notification permission,
  devices note, app version.

Design rules: system font, Title Case for headings, buttons, tabs and labels,
indigo only for interactive elements, no gradients, compact top chrome, light
and dark mode.

### Storage

- Per server: `authUrl`, `name`, `deviceToken` (in `expo-secure-store`), user.
- The push private key never leaves the Keychain (below).

### Push on iOS

- A local Expo module (`mobile/modules/astrodock-push`, Swift) creates and keeps
  one Curve25519 key pair per server in the Keychain, in a shared access group
  (`$(AppIdentifierPrefix)ai.astrodock.mobile.shared`), and returns the public
  key. Functions: `publicKey(serverId) -> base64`, `deleteKey(serverId)`.
- A Notification Service Extension (added with `@bacons/apple-targets`) reads
  `ad.s` and `ad.x`, loads that server's key from the shared Keychain group,
  decrypts, and replaces the title and body with the app name, title and body.
  It sets `userInfo` so a tap opens the right app. If anything fails it leaves
  the generic text.
- Flow after sign-in: ask notification permission → `getDevicePushTokenAsync()`
  (raw APNs token) → relay `POST /v1/subscriptions` → server `PUT /mobile/push`
  with the handle and public key. Environment is `sandbox` for development
  builds and `production` for TestFlight and App Store builds.
- Tapping a notification opens the Inbox entry's app at its path.

### Native features

Most come from the WebView itself, given the usage strings in `Info.plist`:
file and photo upload, camera capture (`<input type="file" capture>`),
microphone, and geolocation. A small bridge, `window.astrodock`, is injected
only into pages on the server's own hosts (`*.<baseDomain>`):

- `astrodock.share({ url, text })` → the native share sheet
- `astrodock.haptic("light"|"medium"|"success"|"warning"|"error")`
- `astrodock.openExternal(url)` → the system browser
- `astrodock.platform` → `"ios"|"android"`, `astrodock.version`

Messages from any other origin are ignored.

### Builds

EAS Build with profiles `development`, `preview` and `production`. `eas submit`
uploads production builds to TestFlight. EAS project id, Apple team and the APNs
key are the publisher's and are not in the repository.
