# Releasing Astrodock, and turning on Google sign-in

Two walkthroughs. The first ships a new version to a running platform. The
second configures Google in their console, which is the fiddly half.

---

# Part 1: shipping a release

## How it actually works

The running platform does not build from source. It pulls a published image:

```
you push a v* tag ─▶ GitHub Actions builds ─▶ ghcr.io/astrodock/astrodock:v0.0.19
                                                          │
   dashboard reads GitHub tags (cached 6h) ◀───────────────┘
                     │
   you press Update ─▶ updater container: back up ─▶ pin ─▶ pull ─▶ recreate ─▶ verify
```

So a commit on `main` changes nothing on the server. Only a tag does, and only
after the image finishes building.

## The steps

**1. Versions must already match.** The release workflow refuses a tag whose
version disagrees with `package.json`, because the packages once drifted nine
releases behind the tags. All six are already at `0.0.19` in commit
`chore(release): v0.0.19`.

**2. Push the branch.**

```bash
cd "Unsynced Docs/Astrodock"
git push origin main
```

Wait for CI to pass. It runs lint, the schema tests, the migration, the full
control-plane suite against a real Postgres, the CLI tests and the admin build.
The database-backed tests that cannot run on a laptop run here, including the
new `0013_google_signin.sql` migration.

**3. Tag and push the tag.**

```bash
git tag v0.0.19
git push origin v0.0.19
```

That starts the Release workflow: it checks the tag against `package.json`,
builds for amd64 and arm64, and pushes `:v0.0.19` and `:latest` to ghcr.io.
Watch it at github.com/astrodock/astrodock/actions. Nothing on the server has
changed yet.

**4. Update the platform.** admin.astrodock.ai → Settings → About.

The version check caches for six hours, so the new tag may not appear
immediately. It is a cache, not a failure. To see it sooner, restart the api
container or wait it out.

Press **Update**. Four stages, and the modal names them:

| Stage | What happens |
|---|---|
| Backing up the database | The only way back from a bad migration |
| Downloading the new version | Nothing has changed yet; the running platform is untouched |
| Restarting the platform | **The dashboard stops responding here.** Expected |
| Checking it came back | If it does not answer as the new version, the previous one is put back automatically |

The dashboard going dark in stage three is the update working. It comes back on
its own.

**5. Confirm.** Settings → About should read 0.0.19. Then:

- **Logs tab on any app** should show output for the first time. That was the
  bug that made the Valise outage so hard to find.
- **Restart** on an app should say what the process is doing afterwards.
- Each app has a **History** tab.

## If it does not come back

The updater restores the previous version by itself and records the outcome in
the events table, so the dashboard shows what happened once it returns. If the
dashboard never returns, on the server:

```bash
cd /path/to/astrodock
docker compose ps                 # what is actually running
docker compose logs api --tail 100
```

`.env` holds `ASTRODOCK_VERSION`. Setting it back by hand and running
`docker compose up -d` is the manual version of the automatic rollback.

## Turning the terminal on

Off by default and not enabled by this release. To switch it on, add to `.env`
on the server and recreate:

```
ASTRODOCK_ENABLE_TERMINAL=true
```

```bash
docker compose up -d runner
```

The Terminal tab then appears for admins and owners. It is arbitrary code
execution inside the app's container as the app's user; see `SECURITY.md`.

---

# Part 2: Google sign-in, in the Google console

The confusing parts are that Google calls one thing three names, and that the
consent screen is a separate setup from the credentials.

## 1. Pick or make a project

console.cloud.google.com, project dropdown at the top left. Any project works.
The project is only a container; nothing here costs money.

## 2. Configure the consent screen first

**APIs & Services → OAuth consent screen.** Credentials cannot be created
without it, which is the step most people skip and then cannot find.

| Field | What to put |
|---|---|
| User type | **Internal** if seniorverse.com is a Workspace org and only your people sign in. **External** otherwise |
| App name | Astrodock, or whatever your people should see |
| User support email | Yours |
| Authorized domains | `astrodock.ai` |
| Developer contact | Yours |

**Scopes:** add none. The defaults (`openid`, `email`, `profile`) are what this
uses, and they are granted without being listed. Adding more triggers Google's
verification review for no benefit.

**If you chose External:** the app starts in *Testing*, where only accounts on
the **Test users** list can sign in, and sessions expire after a week. For your
own use that is fine and needs no review. Add yourself as a test user. If other
people need to sign in, press **Publish app** — with only the default scopes
there is no verification review.

**If you chose Internal:** nothing further. Anyone in the Workspace can sign in
and there is no review.

## 3. Create the credentials

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

- Application type: **Web application**
- Name: anything, it is only shown to you

**Authorized JavaScript origins:** leave empty. This flow is a server-side
redirect, not a browser SDK, and an origin here does nothing.

**Authorized redirect URIs:** this is the part that has to be exact. Add both:

```
https://admin.astrodock.ai/admin/google/callback
https://auth.astrodock.ai/login/google/callback
```

Exact string match: scheme, host, path, no trailing slash. A mismatch gives
`redirect_uri_mismatch`, which is the single most common failure and always
means these two strings differ from what the server sent.

The first is for the dashboard. The second is for the hosted sign-in page that
every app shares, which is why one entry covers Valise and everything after it.

Press Create. Google shows a client ID and a client secret. The secret is
shown once.

## 4. Put them into Astrodock

admin.astrodock.ai → **Settings**:

| Setting | Value |
|---|---|
| Google client ID | the `…apps.googleusercontent.com` string |
| Google client secret | from the same dialog |
| Google domains allowed | `seniorverse.com`, or blank for any Google account |

The secret is stored as a secret: the settings page shows `••••••` afterwards
and saving the form again does not overwrite it with the mask.

The domain allowlist is checked against the verified token's own domain, not
anything the browser sends. Blank means any Google account may sign in, and
whether they get anywhere still depends on having an account here.

## 5. Check it

**Dashboard:** sign out, and the login page should show *Continue with Google*
under the passkey button. It appears only when a client ID is set. Signing in
requires an operator account already using that email address — Google never
creates a dashboard account, by design.

**An app:** open any app's sign-in page and the same button should be there.

## What will surprise you

- **Accounts link by Google's `sub`, not by email.** The first Google sign-in
  attaches to an operator with the same verified address; after that the link is
  to the Google identity itself, so changing your address at Google does not
  strand you.
- **Google counts as one factor.** Its ID token carries no claim saying whether
  2FA was used, so an account with TOTP set up is still asked for a code. On the
  hosted app page such accounts are sent back to the password form instead.
- **An unknown Google address cannot create a dashboard account.** Ever. For
  end users of an app, self-service signup is a per-app checkbox on the app's
  Sign-In tab, off by default.
