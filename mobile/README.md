# Astrodock Mobile

The Astrodock app for iOS and Android (Expo, TypeScript, Expo Router). It signs
in to one or more Astrodock servers, lists their apps, opens each app in a
WebView, and receives notifications. The spec is `MOBILE_DESIGN.md` at the
repository root, section 8.

This folder has its own `package.json` and lockfile and is not part of the root
npm workspaces.

## Layout

| Path | What it is |
|---|---|
| `src/app/` | Screens (Expo Router): Apps, Inbox and Settings tabs, Add Server, the App screen |
| `src/lib/` | API clients, discovery, PKCE, server registry, push setup, the `window.astrodock` bridge |
| `modules/astrodock-push/` | Local Expo module (Swift): one Curve25519 key per server in the shared Keychain group |
| `targets/notification-service/` | Notification Service Extension (via `@bacons/apple-targets`) that decrypts pushes |
| `targets/notification-service/PushCrypto.swift` | The decryption, shared by the extension and the test |
| `test/` | Jest tests for the pure logic, and the Swift push-vector test |

## Development

The app has native code (the push module and the extension), so it runs in a
development build, not Expo Go.

```sh
npm install
npx expo run:ios --device      # builds the dev client and installs it on a connected iPhone
npm start                      # Metro for the dev client, after the first install
```

`npx expo run:ios` runs `expo prebuild`, which generates `ios/` (and `android/`
for `run:android`). Both folders are generated and gitignored: change native
settings in `app.config.ts` and `targets/notification-service/expo-target.config.js`.

Signing on a device needs your Apple team: `APPLE_TEAM_ID=XXXXXXXXXX npx expo run:ios --device`.

Checks:

```sh
npx tsc --noEmit
npm test                       # Jest: discovery input, PKCE, bridge origin check, paths
npm run test:push-vector       # Swift decryption against test/push-vector.json (macOS, Xcode)
npx expo-doctor
```

`test/push-vector.json` is a copy of `apps/control-plane/test/fixtures/push-vector.json`.
Copy it again if the control plane's vector changes.

### Push environment

`app.config.ts` reads `APP_VARIANT`, which each EAS profile sets in `eas.json`:

| Profile | `APP_VARIANT` | APNs environment sent to the relay | `aps-environment` |
|---|---|---|---|
| `development` (and local `expo run`) | `development` | `sandbox` | `development` |
| `preview` | `preview` | `production` | `production` |
| `production` | `production` | `production` | `production` |

The app reads it at run time from `Constants.expoConfig.extra.pushEnvironment`.

## Publishing (TestFlight)

Done once by whoever publishes the app. None of these values are in the
repository.

1. **Apple Developer account.** Note the Team ID.
2. **Bundle id.** Register `ai.astrodock.mobile` (or your own, set with
   `APP_BUNDLE_ID`) and `ai.astrodock.mobile.notification-service` for the
   extension. Give both the **Push Notifications** and **Keychain Sharing**
   capabilities. EAS can create these when it builds, if you let it manage
   credentials.
3. **Keychain group.** Both targets use `$(AppIdentifierPrefix)<bundle id>.shared`,
   from `app.config.ts`. Nothing to register by hand: Keychain groups are
   prefixed by the team and need no App Group.
4. **APNs key.** In Certificates, Identifiers & Profiles › Keys, create a key
   with Apple Push Notifications service. Give the `.p8` file, its Key ID and
   your Team ID to the push relay as `RELAY_APNS_KEY`, `RELAY_APNS_KEY_ID`,
   `RELAY_APNS_TEAM_ID`, with `RELAY_APNS_TOPIC` set to the bundle id. The app
   never holds this key.
5. **App Store Connect.** Create the app with the same bundle id.
6. **EAS project.**
   ```sh
   npm install -g eas-cli
   eas login
   eas init                     # writes the EAS project id into the Expo config
   ```
   `app.config.ts` is a function, so `eas init` may ask you to add the printed
   `extra.eas.projectId` by hand: add it to the returned config.
   Set `APPLE_TEAM_ID` as an EAS environment variable (or in your shell for
   local builds).
7. **Build and upload.**
   ```sh
   eas build -p ios --profile production
   eas submit -p ios            # uploads the build to TestFlight
   ```
   `eas submit` asks for the App Store Connect app id the first time; you can
   save it as `submit.production.ios.ascAppId` in `eas.json`.
   App Store Connect asks about export compliance (encryption) for each build
   until you answer it in the app's settings.

### Adding testers in TestFlight

In App Store Connect, open the app › TestFlight.

- **Internal testers** (people on your App Store Connect team): add them to an
  internal group. They can install a build as soon as it finishes processing.
- **External testers** (anyone with an email address): create an external
  group, add their emails or turn on a public link, and add the build to the
  group. The first build for external testers goes through Beta App Review.

Testers install the TestFlight app and accept the invite.
