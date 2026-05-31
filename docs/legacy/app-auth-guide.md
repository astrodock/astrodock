# Integrating a New App with the SV Auth Service

## 1. Overview

The SV auth service is a centralized identity verification and app access gate running at `auth.seniorverse.dev`. When a user logs in to your app, your backend sends their credentials to the auth service's `/verify` endpoint. The auth service checks the password, confirms the user has access to your app, and returns `{ userId, email, name }`. Your app then creates its own session (JWT, cookie, etc.) and manages all subsequent authorization internally.

The auth service is **not** involved after the initial login. It does not issue tokens, manage sessions, or proxy data.

**Auth flow:**

1. User visits your app and sees your login page
2. User enters email + password
3. Your frontend sends credentials to your backend (`POST /api/login`)
4. Your backend calls the auth service (`POST /verify`) using `@sv/auth-client`
5. Auth service verifies credentials + app access, returns `{ userId, email, name }`
6. Your backend creates its own JWT and returns it to the frontend
7. Your app manages all subsequent requests using that JWT

---

## 2. Prerequisites

Before writing any code:

1. **Register your app** in the auth admin UI at `auth.seniorverse.dev` (Apps > Create). You'll need:
   - **Slug** — lowercase kebab-case identifier used everywhere: `appId`, MongoDB database name, Spaces folder prefix, etc. (e.g., `inventory-tracker`)
   - **Name** — display name for the admin UI
   - **Subdomain** — the subdomain for your app (e.g., `inventory` → `inventory.seniorverse.dev`)

   On creation, the admin UI automatically generates and assigns:
   - `appSecret` (shown once — save it immediately, or use "Rotate Secret" later)
   - `PORT` (auto-incremented from 3101)
   - `DB_NAME`, `SPACES_PREFIX`, `AUTH_URL`, `APP_ID`, `APP_SECRET`, `APP_JWT_SECRET`

   These are stored as system environment variables on the app and will be written to the server's `.env` automatically on deploy.

2. **Grant users access** to your app in the admin UI. Each user has an `appAccess` list of app slugs. If a user is not granted access to your app, `/verify` will return `403`.

3. **Add shared environment variables.** In the admin UI (Apps > your app > Environment), add any additional env vars your app needs. Common ones:
   - `MONGODB_URI` — copy from another app or from the Droplet's `/opt/apps/.env.shared`
   - `SPACES_REGION`, `SPACES_BUCKET`, `SPACES_KEY`, `SPACES_SECRET` — if your app uses DO Spaces

---

## 3. Install @sv/auth-client

`@sv/auth-client` is a small server-side Node.js package that wraps the `/verify` call. It is not published to npm yet, so install it from a local path or copy the package into your repo.

**Option A: Install from local path (if you have the monorepo cloned)**

```bash
cd server
npm install ../../packages/auth-client
```

This adds it to your `package.json` as a `file:` dependency.

**Option B: Copy the package into your repo**

Create `server/packages/auth-client/` with two files:

**package.json**
```json
{
  "name": "@sv/auth-client",
  "version": "1.0.0",
  "description": "Server-side client for the SV auth service",
  "main": "index.js",
  "files": ["index.js"]
}
```

**index.js**
```javascript
class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class SvAuth {
  constructor({ authUrl = 'http://localhost:3100', appId, appSecret }) {
    if (!appId) throw new Error('appId is required');
    if (!appSecret) throw new Error('appSecret is required');

    this.authUrl = authUrl.replace(/\/$/, '');
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async verify(email, password) {
    let res;
    try {
      res = await fetch(`${this.authUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          appId: this.appId,
          appSecret: this.appSecret
        })
      });
    } catch (err) {
      throw new AuthError('Auth service unavailable', 503);
    }

    if (res.status === 401) throw new AuthError('Invalid credentials', 401);
    if (res.status === 403) throw new AuthError('No access to this app', 403);
    if (!res.ok) throw new AuthError('Auth service error', res.status);

    return res.json(); // { userId, email, name }
  }
}

module.exports = { SvAuth, AuthError };
```

Then install it:

```bash
cd server
npm install ./packages/auth-client
```

---

## 4. Backend Setup (Express)

### Install dependencies

```bash
cd server
npm install express jsonwebtoken cors dotenv
```

### Environment variables (local dev only)

Create `server/.env` for local development. In production, environment variables are managed through the admin UI and written automatically on deploy.

```
PORT=3101
AUTH_URL=https://auth.seniorverse.dev
APP_ID=your-app-slug
APP_SECRET=sk_your_app_secret_here
APP_JWT_SECRET=generate-a-random-string-here
MONGODB_URI=mongodb+srv://...
DB_NAME=your-app-slug
```

Generate `APP_JWT_SECRET` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Get `APP_SECRET` from the admin UI (shown once on app creation, or rotate to get a new one).

### server/server.js

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { SvAuth, AuthError } = require('@sv/auth-client');

const app = express();
app.use(cors());
app.use(express.json());

// ── Initialize auth client ──────────────────────────────────────────

const auth = new SvAuth({
  authUrl: process.env.AUTH_URL,
  appId: process.env.APP_ID,
  appSecret: process.env.APP_SECRET
});

// ── Login endpoint ──────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Verify credentials + app access via auth service
    const user = await auth.verify(email, password);

    // Create this app's own JWT session
    const token = jwt.sign(
      { sub: user.userId, email: user.email, name: user.name },
      process.env.APP_JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, user });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Auth middleware (for protected routes) ───────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.APP_JWT_SECRET);
    req.user = { userId: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Protected routes ────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Example: add more protected routes
// app.get('/api/data', requireAuth, async (req, res) => {
//   const data = await db.collection('items').find({ ownerId: req.user.userId }).toArray();
//   res.json({ data });
// });

// ── Start server ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3101;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
```

---

## 5. Frontend Setup (React)

### Auth context

Create a context that stores the JWT token and user info, and provides login/logout functions.

**app/src/context/AuthContext.jsx**

```jsx
import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount (or token change), validate the token by calling /api/me
  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    fetch('/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => {
        if (!res.ok) throw new Error('Invalid token');
        return res.json();
      })
      .then(data => setUser(data.user))
      .catch(() => {
        // Token expired or invalid — clear it
        localStorage.removeItem('token');
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function login(email, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }

    const data = await res.json();
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
  }

  function logout() {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

### Login page

**app/src/pages/LoginPage.jsx**

```jsx
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await login(email, password);
      // AuthContext will update user state, triggering a redirect (see App.jsx)
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>Log In</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Logging in...' : 'Log In'}
        </button>
      </form>
    </div>
  );
}
```

### Protected route pattern

**app/src/App.jsx**

```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;

  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <div>Loading...</div>;

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
```

### Handling token expiry

The `AuthContext` already handles expired tokens: if `/api/me` returns a non-OK response, the token is cleared and the user is redirected to login.

For a better experience on long-lived pages, add a fetch wrapper that catches 401s globally:

**app/src/utils/api.js**

```javascript
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token');

  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers
    }
  });

  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  return res;
}
```

Use `apiFetch` instead of `fetch` for all authenticated API calls:

```javascript
const res = await apiFetch('/api/data');
const data = await res.json();
```

---

## 6. Environment Variables

### Auto-generated (system) env vars

These are created automatically when you register the app in the admin UI. They cannot be edited through the UI:

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Port for the Express API (auto-assigned) | `3101` |
| `AUTH_URL` | URL of the auth service (`http://localhost:3100` in production) | `http://localhost:3100` |
| `APP_ID` | Your app's slug | `inventory-tracker` |
| `APP_SECRET` | Your app's secret (rotatable via admin UI) | `sk_prod_abc123` |
| `APP_JWT_SECRET` | Random secret for signing your app's JWTs | `a3f8...` (64 hex chars) |
| `DB_NAME` | Your app's MongoDB database name (matches slug) | `inventory-tracker` |
| `SPACES_PREFIX` | Your app's DO Spaces folder prefix (matches slug) | `inventory-tracker` |

### Manual env vars (add via admin UI)

Add these through Apps > your app > Environment in the admin UI. You can add them one at a time or bulk-import from `.env` format.

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | Shared MongoDB connection string | `mongodb+srv://...` |
| `SPACES_REGION` | DO Spaces region (if using Spaces) | `nyc3` |
| `SPACES_BUCKET` | DO Spaces bucket name (if using Spaces) | `sv-tools-data` |
| `SPACES_KEY` | DO Spaces access key (if using Spaces) | `DO...` |
| `SPACES_SECRET` | DO Spaces secret key (if using Spaces) | `...` |

### Local development

For local dev, create a `server/.env` manually. The key difference from production:

**Important:** `AUTH_URL` is backwards from what you might expect:
- **On the Droplet (production):** `http://localhost:3100` -- the auth service runs on the same machine, so calls stay on localhost. This is set automatically by the admin UI.
- **On your laptop (local dev):** `https://auth.seniorverse.dev` -- you call the auth service over the internet. Set this in your local `.env`.

---

## 7. Project Structure

Use this layout to match the deploy pipeline. The auth service's deploy worker expects `app/` and `server/` directories at the repo root (or within the configured `repoPath`):

```
your-app/
  app/                          # React frontend (Vite)
    src/
      context/
        AuthContext.jsx
      pages/
        LoginPage.jsx
        DashboardPage.jsx
      utils/
        api.js
      App.jsx
      main.jsx
    index.html
    package.json
    vite.config.js

  server/                       # Express backend
    packages/
      auth-client/              # @sv/auth-client (copied or linked)
        index.js
        package.json
    server.js
    package.json
    .env                        # local dev env vars (git-ignored)

  .gitignore
```

The deploy worker also supports:
- **Standalone server** — a `server.js` at the repo root (no `app/` or `server/` directories)
- **Standalone frontend** — a `package.json` at the repo root with no `server.js`
- **Monorepo subdirectory** — set `repoPath` when connecting the GitHub repo to point at a subdirectory (e.g., `packages/my-app`)

On deploy, the worker runs `npm ci && npm run build` in `app/`, `npm ci --production` in `server/`, then copies `app/dist/` to `/var/www/{app-name}/` and `server/` to `/opt/apps/{app-name}-api/` on the Droplet.

---

## 8. Deploying to Production

Deployment is handled automatically by the auth service. No GitHub Actions workflow or manual SSH is needed.

### Step 1: Provision the app

In the admin UI (Apps > your app), click **Provision**. This:
- Creates `/var/www/{app-slug}/` (static files directory)
- Creates `/opt/apps/{app-slug}-api/` (server directory)
- Writes the `.env` file from the app's stored environment variables
- Updates the Caddyfile with a new subdomain block and reloads Caddy

### Step 2: Connect a GitHub repo

In the admin UI (Apps > your app), click **Connect Repo**. Select the repo and configure:
- **Branch** — the branch to deploy from (default: `main`)
- **Repo path** — subdirectory to deploy from, if your app lives in a monorepo (leave blank for repo root)

This creates a GitHub webhook so pushes to the configured branch trigger automatic deploys.

### Step 3: Push and deploy

Push code to the configured branch. The deploy worker will:
1. Clone or pull the repo
2. Run `npm ci && npm run build` in the `app/` directory (if it exists)
3. Run `npm ci --production` in the `server/` directory (if it exists)
4. Copy `app/dist/` → `/var/www/{app-slug}/`
5. Copy `server/` → `/opt/apps/{app-slug}-api/`
6. Write the `.env` from the admin UI's stored environment variables
7. Start or restart the PM2 process

You can also trigger a deploy manually from the admin UI (Apps > your app > **Deploy**).

### Monitoring deploys

The admin UI shows deployment history with status (`pending` → `cloning` → `building` → `deploying` → `success`/`failed`) and full logs. You can also view PM2 logs and process status from the admin UI.

---

## 9. Testing Locally

1. **Start your backend** pointing at the remote auth service:

    ```bash
    cd server
    # In .env, set:
    #   AUTH_URL=https://auth.seniorverse.dev
    #   APP_ID=your-app-slug
    #   APP_SECRET=sk_your_secret
    #   APP_JWT_SECRET=any-random-string
    #   PORT=3101
    node server.js
    ```

2. **Start your frontend** with Vite proxying API requests to the backend:

    **app/vite.config.js**
    ```javascript
    import { defineConfig } from 'vite';
    import react from '@vitejs/plugin-react';

    export default defineConfig({
      plugins: [react()],
      server: {
        port: 5173,
        proxy: {
          '/api': 'http://localhost:3101'
        }
      }
    });
    ```

    ```bash
    cd app
    npm run dev
    ```

3. **Open** `http://localhost:5173` in your browser and log in with credentials that have been granted access to your app in the admin UI.

4. **Verify it works:**
    - Login should succeed and redirect to the dashboard
    - `/api/me` should return your user info
    - Using wrong credentials should show "Invalid credentials"
    - Using credentials for a user without app access should show "No access to this app"

### Troubleshooting

- **"Auth service unavailable"** -- Check that `AUTH_URL` is correct and that `auth.seniorverse.dev` is reachable from your machine.
- **"Invalid app credentials"** -- Verify `APP_ID` matches the slug in the admin UI and `APP_SECRET` is correct (rotate it if you lost it).
- **"No access to this app"** -- Grant the user access in the auth admin UI under the user's app access settings.
- **Deploy fails at "building"** -- Check the deploy log in the admin UI. Common causes: missing `npm run build` script in `app/package.json`, or build errors in your frontend code.
- **App not accessible after deploy** -- Verify the app is provisioned (check for the Caddy block). Ensure DNS has a wildcard A record pointing to the Droplet IP.
