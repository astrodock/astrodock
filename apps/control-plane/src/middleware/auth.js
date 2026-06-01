'use strict';

const jwt = require('jsonwebtoken');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { hashToken } = require('../lib/ids');

// Resolve the caller from the Authorization header. Returns one of:
//   { type: 'admin', email }                 — a valid admin JWT
//   { type: 'token', id, name, scopes[] }     — a valid scoped API token
//   null                                      — no/invalid credentials
async function resolveAuth(req) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) return null;

  // Scoped API token (tk_...) — looked up by hash.
  if (raw.startsWith('tk_')) {
    const tokenHash = hashToken(raw);
    const rows = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, tokenHash)).limit(1);
    const tok = rows[0];
    if (!tok) return null;
    // best-effort last-used stamp (don't block on it)
    db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, tok.id)).catch(() => {});
    return { type: 'token', id: tok.id, name: tok.name, scopes: tok.scopes || [], appScope: tok.appScope || [] };
  }

  // Admin JWT.
  try {
    const payload = jwt.verify(raw, config.adminJwtSecret);
    if (!payload.isAdmin) return null;
    return { type: 'admin', email: payload.email, sub: payload.sub };
  } catch {
    return null;
  }
}

function tokenHasScope(scopes, scope) {
  return Array.isArray(scopes) && (scopes.includes('*') || scopes.includes(scope));
}

// Admin JWT ONLY. Used for user management and token management — scoped API
// tokens (i.e. agents) are deliberately excluded from these surfaces.
function requireAdmin(req, res, next) {
  resolveAuth(req).then((auth) => {
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (auth.type !== 'admin') return res.status(403).json({ error: 'Admin access required (API tokens cannot manage users or tokens)' });
    req.auth = auth;
    next();
  }).catch((err) => res.status(500).json({ error: err.message }));
}

// Admin JWT OR a scoped API token that carries `scope`. Used for the app /
// deploy / env / observability surface that an agent drives.
// A token may be restricted to specific app slugs. Empty appScope = all apps.
function tokenAllowsApp(auth, slug) {
  if (auth.type !== 'token') return true;
  const scope = auth.appScope || [];
  return scope.length === 0 || (slug && scope.includes(slug));
}

function requireScope(scope) {
  return (req, res, next) => {
    resolveAuth(req).then((auth) => {
      if (!auth) return res.status(401).json({ error: 'Authentication required' });
      if (auth.type === 'admin') { req.auth = auth; return next(); }
      if (auth.type === 'token' && tokenHasScope(auth.scopes, scope)) {
        // NB: per-app scope is enforced per-route (router.param('slug') on the apps router,
        // and explicit tokenAllowsApp filters on the cross-app list/activity/health routes).
        // It can't be enforced here — req.params isn't populated in router-level use().
        req.auth = auth; return next();
      }
      return res.status(403).json({ error: `Insufficient scope (need "${scope}")` });
    }).catch((err) => res.status(500).json({ error: err.message }));
  };
}

module.exports = { resolveAuth, requireAdmin, requireScope, tokenHasScope, tokenAllowsApp };
