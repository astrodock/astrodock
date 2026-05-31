# SV Tools Platform Architecture

## Overview

A shared infrastructure platform for deploying internal tools. One Droplet runs all apps behind Caddy (reverse proxy + auto HTTPS). One managed MongoDB cluster and one DO Spaces bucket are shared across all apps. A central auth service verifies user identity and app access via a server-to-server API — each app has its own login page and manages its own sessions and permissions internally.

---

## Infrastructure

### Digital Ocean Resources

| Resource | Purpose | Cost |
|----------|---------|------|
| Droplet (2GB / 1 vCPU) | Runs Caddy, auth API, all app APIs, serves all static frontends | ~$12-24/mo |
| Managed MongoDB | One database per app (`auth`, `financial-model`, `crm`, etc.) | ~$15/mo |
| Spaces (1 bucket) | Document storage, one top-level folder per app | $5/mo |
| **Total** | | **~$32-44/mo** |

### Domain Structure

```
seniorverse.dev                  <- landing / app directory (optional)
auth.seniorverse.dev             <- auth service API + admin UI
model.seniorverse.dev            <- financial model
crm.seniorverse.dev              <- CRM
*.seniorverse.dev                <- future apps
```

---

## Architecture Diagram

```
                      *.seniorverse.dev
                              |
                        +-----------+
                        |   Caddy   |  <- auto HTTPS, reverse proxy
                        |  :80/443  |
                        +-----+-----+
              +---------------+---------------+
              |               |               |
          auth.*          model.*          crm.*
              |               |               |
        +-----+-----+   +----+----+     +----+----+
        | Auth API  |<--| App API |     | App API |
        |  :3100    |<--|  :3101  |     |  :3102  |
        +-----+-----+   +----+----+     +----+----+
              |               |               |
              +-------+-------+-------+-------+
                      |               |
              +-------+---+    +------+------+
              |  Managed  |    |  DO Spaces  |
              |  MongoDB  |    |  (1 bucket) |
              +-----------+    +-------------+

        * = .seniorverse.dev
        <-- App APIs call Auth API via /verify
            (localhost:3100 in prod, https://auth.seniorverse.dev in local dev)
```

---

## Auth Service

### Responsibilities

1. Verify user credentials and app access (`/verify` endpoint)
2. User CRUD (admin only)
3. App registration and secret management
4. Admin UI for managing all of the above

The auth service is an **identity verification and app access gate**. It does not issue tokens, manage sessions, or proxy data. Each app handles its own sessions, permissions, and data access.

### Tech Stack

- Node.js + Express
- MongoDB (`auth` database)
- bcrypt (password hashing)

### MongoDB Collections (auth database)

**users**
```json
{
  "_id": "ObjectId",
  "email": "paul@example.com",
  "name": "Paul",
  "passwordHash": "$2b$12$...",
  "isActive": true,
  "isAdmin": true,
  "appAccess": ["financial-model", "crm"],
  "createdAt": "2026-03-21T...",
  "updatedAt": "2026-03-21T..."
}
```

- `isAdmin` controls access to the admin UI and admin API endpoints.
- `appAccess` is a list of app slugs the user can access. No roles — each app manages its own permissions internally, keyed to the `userId` returned by `/verify`.

**apps**
```json
{
  "_id": "ObjectId",
  "slug": "financial-model",
  "name": "Financial Model",
  "description": "SV financial projections and actuals",
  "appSecret": "sk_abc123..."
}
```

- `appSecret` is generated when the app is registered in the admin UI. It gates the `/verify` endpoint so only registered apps can call it.

### API Endpoints

**Verification (called by app backends):**
```
POST   /verify   { email, password, appId, appSecret }
                 -> { userId, email, name }
                 or 401 (invalid credentials)
                 or 403 (user does not have access to this app)
                 or 401 (invalid app secret)
```

**Admin - User Management:**
```
GET    /admin/users                          -> { users[] }
POST   /admin/users         { email, name, password } -> { user }
PATCH  /admin/users/:id     { name?, isActive? }      -> { user }
DELETE /admin/users/:id                      -> 204
POST   /admin/users/:id/reset-password  { newPassword } -> 204
```

**Admin - App Access:**
```
PUT    /admin/users/:id/access/:appSlug      -> 204  (grant access)
DELETE /admin/users/:id/access/:appSlug      -> 204  (revoke access)
```

**Admin - App Management:**
```
GET    /admin/apps                           -> { apps[] }
POST   /admin/apps       { slug, name }      -> { app, appSecret }
DELETE /admin/apps/:slug                     -> 204
POST   /admin/apps/:slug/rotate-secret       -> { appSecret }
```

- `POST /admin/apps` returns the `appSecret` once on creation. It is not retrievable after that — use `rotate-secret` to generate a new one if lost.
- All `/admin` endpoints require authentication. The admin UI has its own login page and session, authenticating directly against the `users` collection (checking `isAdmin`).

### Auth Flow

1. User visits `model.seniorverse.dev` and sees the app's own login page
2. User enters credentials
3. App frontend sends credentials to its own backend (`POST /api/login`)
4. App backend calls auth service: `POST localhost:3100/verify` (or `https://auth.seniorverse.dev/verify` in local dev)
5. Auth service verifies credentials, checks `appAccess`, returns `{ userId, email, name }`
6. App backend creates its own session (its own JWT, cookie, etc.) and includes `userId`
7. App manages all subsequent authorization and permissions internally using `userId`

---

## Shared Auth Client Package

A small server-side Node.js package used by each app's Express backend to call the auth service:

```javascript
// @sv/auth-client

class SvAuth {
  constructor({ authUrl = 'http://localhost:3100', appId, appSecret }) {
    this.authUrl = authUrl;
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async verify(email, password) {
    const res = await fetch(`${this.authUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        appId: this.appId,
        appSecret: this.appSecret
      })
    });

    if (res.status === 401) throw new AuthError('Invalid credentials');
    if (res.status === 403) throw new AuthError('No access to this app');
    if (!res.ok) throw new AuthError('Auth service unavailable');

    return res.json(); // { userId, email, name }
  }
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

module.exports = { SvAuth, AuthError };
```

Usage in any app:

```javascript
const { SvAuth, AuthError } = require('@sv/auth-client');
const jwt = require('jsonwebtoken');

const auth = new SvAuth({
  authUrl: process.env.AUTH_URL,
  appId: process.env.APP_ID,
  appSecret: process.env.APP_SECRET
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await auth.verify(email, password);

    // App creates its own session — whatever makes sense for this app
    const token = jwt.sign(
      { sub: user.userId, email: user.email, name: user.name },
      process.env.APP_JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, user });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    res.status(500).json({ error: 'Login failed' });
  }
});
```

Each app is free to manage its own session however it wants — JWT lifetime, cookie strategy, refresh logic, etc. The auth service is not involved after the initial `/verify` call.

---

## Per-App Data Access

Each app's Express API connects to its own MongoDB database and its own Spaces folder directly. The auth service is not involved in data access — only in verifying identity.

**MongoDB:** Each app connects to its own database within the shared cluster.
```
mongodb+srv://.../?authSource=admin
  -> database: financial-model
  -> database: crm
  -> database: auth
```

**DO Spaces:** Each app reads/writes under its own prefix.
```
sv-tools-data/                    <- bucket name
  financial-model/                <- app prefix
    exports/
    uploads/
  crm/
    documents/
  auth/
    backups/
```

Apps use `@aws-sdk/client-s3` to interact with Spaces (S3-compatible). Spaces credentials are shared across apps via environment variables on the Droplet.

---

## Droplet Setup

### Software

- **Caddy** - reverse proxy, auto HTTPS
- **Node.js** (LTS) - runtime for all APIs
- **PM2** - process manager (auto-restart on crash, log management)

### Caddy Configuration

```
auth.seniorverse.dev {
    reverse_proxy localhost:3100
}

model.seniorverse.dev {
    root * /var/www/financial-model
    try_files {path} /index.html
    file_server

    handle /api/* {
        reverse_proxy localhost:3101
    }
}

crm.seniorverse.dev {
    root * /var/www/crm
    try_files {path} /index.html
    file_server

    handle /api/* {
        reverse_proxy localhost:3102
    }
}
```

Adding a new app = adding a similar block and reloading Caddy.

### PM2 Process Management

```bash
pm2 start server.js --name auth-api -- --port 3100
pm2 start server.js --name model-api -- --port 3101
pm2 start server.js --name crm-api -- --port 3102
pm2 save
pm2 startup    # auto-start on reboot
```

### Directory Structure on Droplet

```
/var/www/
  financial-model/          <- Vite build output (static files)
  crm/
  auth-admin/

/opt/apps/
  auth-api/                 <- Express API source
  model-api/
  crm-api/

/etc/caddy/
  Caddyfile                 <- reverse proxy config
```

### Environment Variables

Set in `/opt/apps/.env.shared` (sourced by all apps):
```
MONGODB_URI=mongodb+srv://...
SPACES_REGION=nyc3
SPACES_BUCKET=sv-tools-data
SPACES_KEY=...
SPACES_SECRET=...
```

Per-app overrides in `/opt/apps/{app-name}/.env`:
```
PORT=3101
DB_NAME=financial-model
SPACES_PREFIX=financial-model
AUTH_URL=http://localhost:3100
APP_ID=financial-model
APP_SECRET=sk_prod_xyz789
APP_JWT_SECRET=...
```

Note: `AUTH_URL` is `http://localhost:3100` in production (server-to-server on the same Droplet) and `https://auth.seniorverse.dev` for local development.

---

## GitHub Actions Deploy (Template)

Each repo gets this workflow (adjust app name and port):

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      # Build frontend
      - run: cd app && npm ci && npm run build

      # Build backend (if applicable)
      - run: cd server && npm ci

      # Deploy to Droplet
      - uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.DROPLET_IP }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: "app/dist/*,server/*"
          target: "/tmp/deploy-${{ github.repository }}"

      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DROPLET_IP }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            APP_NAME="financial-model"
            rsync -a /tmp/deploy-*/app/dist/ /var/www/$APP_NAME/
            rsync -a /tmp/deploy-*/server/ /opt/apps/$APP_NAME-api/
            cd /opt/apps/$APP_NAME-api && npm ci --production
            pm2 restart $APP_NAME-api
            rm -rf /tmp/deploy-*
```

Set `DROPLET_IP` and `DEPLOY_SSH_KEY` as GitHub repository secrets (or organization-level secrets to share across repos).

---

## Security

- App secrets gate the `/verify` endpoint — only registered apps can call it
- Rate limiting on `/verify` — prevents brute force credential testing
- HTTPS everywhere via Caddy's automatic Let's Encrypt
- Password hashing with bcrypt (cost factor 12)
- Each app manages its own tokens and sessions independently (no shared JWT secret)
- CORS restricted to `*.seniorverse.dev`
- MongoDB encrypted at rest (managed service default)
- App secrets and Spaces credentials never in client code
- In production, `/verify` calls stay on localhost (never leave the Droplet)

---

## Adding a New App (Checklist)

1. **Auth:** Register the app in admin UI — get the `appSecret`
2. **Code:** Build Express API + React frontend using `@sv/auth-client` for login
3. **MongoDB:** No action — app creates its own database on first write
4. **Spaces:** No action — app creates its own folder prefix on first write
5. **Droplet:**
   - Deploy static files to `/var/www/{app-name}/`
   - Deploy API to `/opt/apps/{app-name}-api/`
   - Add `.env` with `PORT`, `DB_NAME`, `AUTH_URL`, `APP_ID`, `APP_SECRET`, `APP_JWT_SECRET`
   - `pm2 start server.js --name {app-name}-api`
   - Add Caddy block, `caddy reload`
6. **DNS:** Add subdomain A record pointing to Droplet IP
7. **GitHub:** Add deploy workflow using the template above
8. **Auth:** Grant users access to the new app in admin UI

---

## Future: SSO (Optional)

The current design requires users to log in to each app separately. If single sign-on is needed later, it can be added without rearchitecting:

1. Auth service gets its own login page and session cookie on `auth.seniorverse.dev`
2. Apps redirect to `auth.seniorverse.dev/login?appId=X&redirect=https://app.seniorverse.dev/auth/callback` instead of showing their own login form
3. If the user already has a session cookie on `auth.seniorverse.dev` (from another app), the auth service skips the login form and immediately redirects back with a one-time authorization code
4. App backend exchanges the code for `{ userId, email, name }` via a server-to-server call (similar to `/verify`, using the app secret)
5. App creates its own session as before

This is a standard authorization code flow. The app secret infrastructure is already in place — SSO just adds a redirect layer and a short-lived codes collection on top.

---

## Build Order

1. **Droplet setup** — Caddy, Node.js, PM2, DNS, env vars
2. **Auth service API** — `/verify` endpoint, user/app CRUD, admin auth
3. **Auth admin UI** — React app for managing users, apps, and access
4. **Shared package** — `@sv/auth-client` (server-side Node.js package)
5. **Migrate financial model** — add login page, integrate `@sv/auth-client`, add Express API for MongoDB/Spaces persistence
6. **Additional apps** — repeat step 5 pattern
