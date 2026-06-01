# Screenshots

The docs pages show a dashed **placeholder box** wherever a screenshot belongs. Drop a real
image here with the matching filename and it appears automatically on next page load — no code
change needed (the placeholder renderer in `../docs.js` swaps the box for the image once the file
exists).

Recommended: PNG, ~1400px wide, light theme, cropped to the relevant UI.

## Images the docs expect

| File | Shown on | What to capture |
|------|----------|-----------------|
| `login.png` | install, (others) | The dashboard login screen |
| `apps-list.png` | admin-ui | The Apps list (subdomains + status) |
| `app-settings.png` | admin-ui | An app's Settings tab |
| `app-env.png` / `env-tab.png` | admin-ui, secrets | An app's Env vars tab (secrets masked) |
| `app-deploys.png` / `deploys-tab.png` | admin-ui, deploy-lifecycle | The Deploys tab (history + live status) |
| `app-logs.png` | admin-ui | The Logs tab streaming output |
| `users-list.png` | admin-ui, users | The Users page |
| `users-new.png` | users | Creating an app end-user |
| `users-grant-access.png` | users, first-app | Granting a user access to an app |
| `tokens-create.png` | api-tokens, first-app | Creating a scoped API token |
| `activity.png` | admin-ui | The Activity feed (deploys + auth logs) |
| `health.png` / `health-page.png` | admin-ui, email | The Health page |
| `starter-running.png` | first-app | The starter app running after login |

> Some screens are referenced by two filenames (different pages named them slightly differently).
> Just save the image under both names, or rename the references — they're only placeholders.
