'use strict';

/**
 * Astrodock starter — Express server.
 *
 * The platform injects everything this needs as environment variables (see
 * AGENTS.md). The contract that matters here:
 *   - BIND to process.env.ASTRODOCK_PORT (Caddy proxies /api/* here).
 *   - Namespace every route under /api (the frontend is served at the same origin).
 *   - To log a user in, ask the control plane "are these credentials valid for me?"
 *     by POSTing to ASTRODOCK_AUTH_URL/verify with ASTRODOCK_APP_ID + ASTRODOCK_APP_SECRET,
 *     then mint your OWN session (here: a JWT signed with ASTRODOCK_APP_JWT_SECRET).
 *
 * This file calls /verify directly via fetch so the starter has zero extra
 * dependencies. The `@astrodock/auth-client` package wraps exactly this call.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const PORT = process.env.ASTRODOCK_PORT || process.env.PORT || 3000;
const AUTH_URL = (process.env.ASTRODOCK_AUTH_URL || '').replace(/\/$/, '');
const APP_ID = process.env.ASTRODOCK_APP_ID;
const APP_SECRET = process.env.ASTRODOCK_APP_SECRET;
const APP_JWT_SECRET = process.env.ASTRODOCK_APP_JWT_SECRET || 'dev-secret';
const WELCOME = process.env.WELCOME_MESSAGE || 'Welcome to your Astrodock app';

const app = express();
app.use(express.json());
app.use(cookieParser());

// Health probe the platform uses to mark the deploy healthy.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Ask the platform to verify end-user credentials, then mint our own session.
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!AUTH_URL || !APP_ID || !APP_SECRET) {
    return res.status(500).json({ error: 'Platform auth is not configured (auth.mode must be "platform")' });
  }

  let verifyRes;
  try {
    verifyRes = await fetch(`${AUTH_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, appId: APP_ID, appSecret: APP_SECRET })
    });
  } catch {
    return res.status(503).json({ error: 'Auth service unavailable' });
  }
  if (verifyRes.status === 401) return res.status(401).json({ error: 'Invalid credentials' });
  if (verifyRes.status === 403) return res.status(403).json({ error: 'You do not have access to this app' });
  if (!verifyRes.ok) return res.status(502).json({ error: 'Auth error' });

  const user = await verifyRes.json(); // { userId, email, name }
  const session = jwt.sign({ sub: user.userId, email: user.email, name: user.name }, APP_JWT_SECRET, { expiresIn: '7d' });
  res.cookie('session', session, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7 * 864e5 });
  res.json({ user });
});

function currentUser(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  try { return jwt.verify(token, APP_JWT_SECRET); } catch { return null; }
}

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: { id: u.sub, email: u.email, name: u.name }, welcome: WELCOME });
});

app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

// A trivial authenticated demo endpoint. In a real app this is where you'd read
// ASTRODOCK_DATABASE_URL (database.mode=internal|external) or the ASTRODOCK_STORAGE_*
// vars (storage.mode) — same code for internal vs external; only the values differ.
const notes = [];
app.get('/api/notes', (req, res) => {
  if (!currentUser(req)) return res.status(401).json({ error: 'Not logged in' });
  res.json({ notes });
});
app.post('/api/notes', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  notes.push({ text, by: u.email, at: new Date().toISOString() });
  res.status(201).json({ notes });
});

app.listen(PORT, () => console.log(`starter server on :${PORT} (app=${APP_ID || 'unconfigured'})`));
