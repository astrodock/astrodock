'use strict';

const jwt = require('jsonwebtoken');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { hashToken } = require('../lib/ids');
const scopes = require('../lib/scopes');
const roles = require('../lib/roles');

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
    if (tok.revokedAt) return null;
    if (tok.expiresAt && new Date(tok.expiresAt) <= new Date()) return null;
    // best-effort last-used stamp (don't block on it)
    db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, tok.id)).catch(() => {});
    return {
      type: 'token',
      id: tok.id,
      name: tok.name,
      // Expanded once here, so every caller sees the current vocabulary and legacy
      // tokens behave identically to reissued ones.
      scopes: scopes.expand(tok.scopes || []),
      rawScopes: tok.scopes || [],
      appScope: tok.appScope || [],
      expiresAt: tok.expiresAt || null,
      authorizedByUserId: tok.authorizedByUserId || null
    };
  }

  // Operator session JWT.
  let payload;
  try {
    payload = jwt.verify(raw, config.adminJwtSecret);
  } catch {
    return null;
  }
  // A session id makes revocation possible: an 8h JWT with no server-side record
  // could not be killed. Tokens minted before sessions existed have no sid and
  // are accepted until they expire on their own.
  let sess = null;
  if (payload.sid) {
    const srows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, payload.sid)).limit(1);
    sess = srows[0];
    if (!sess || sess.revokedAt || new Date(sess.expiresAt) <= new Date()) return null;
  } else if (!payload.isAdmin) {
    return null;
  }
  // The role comes from the account, not the token. A token carries the role it
  // was signed with, so a demoted or deactivated operator would otherwise keep
  // their old access until it expired.
  const userId = sess ? sess.userId : payload.sub;
  if (!userId) return null;
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const user = urows[0];
  if (!user || !user.isActive || !roles.isOperator(user)) return null;
  if (sess) {
    db.update(schema.sessions).set({ lastSeenAt: new Date() }).where(eq(schema.sessions.id, sess.id)).catch(() => {});
    return {
      type: 'admin', email: user.email, sub: user.id,
      role: user.operatorRole, sessionId: sess.id, reauthAt: sess.reauthAt || null,
      purpose: sess.purpose || null
    };
  }
  return { type: 'admin', email: user.email, sub: user.id, role: user.operatorRole };
}

// A welcome session (lib/sessions) reaches only the routes that set up sign-in.
// 403, not 401: the dashboard signs out on a 401, and this session is valid.
function welcomeRefused(req, res, auth) {
  if (!auth || auth.purpose !== 'welcome') return false;
  if (require('../lib/sessions').welcomeAllows(req)) return false;
  res.status(403).json({ error: 'Set up a passkey or password first.', code: 'welcome_only' });
  return true;
}

function tokenHasScope(list, scope) {
  if (!Array.isArray(list)) return false;
  if (list.includes('*')) return true;
  return scopes.expand(list).includes(scope);
}

// What may this caller do? One question for keys and people alike — an operator's
// role expands to the same scope vocabulary a key holds.
function grantedScopes(auth) {
  if (!auth) return [];
  if (auth.type === 'token') return auth.scopes || [];
  return roles.scopesFor(auth.role || 'admin');
}

function callerHasScope(auth, scope) {
  return grantedScopes(auth).includes(scope);
}

// Admin JWT ONLY. Used for user management and token management — scoped API
// tokens (i.e. agents) are deliberately excluded from these surfaces.
function requireAdmin(req, res, next) {
  resolveAuth(req).then((auth) => {
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (auth.type !== 'admin') return res.status(403).json({ error: 'Admin access required (API tokens cannot manage users or tokens)' });
    if (welcomeRefused(req, res, auth)) return;
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
      if (welcomeRefused(req, res, auth)) return;
      // People are held to their role: a viewer holds every :read scope and
      // nothing else.
      if (auth.type === 'admin' && callerHasScope(auth, scope)) { req.auth = auth; return next(); }
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

/**
 * Require a specific permission, of a key OR a person. `requireScope` guards a
 * whole router; this guards one route, so an endpoint declares what it needs
 * rather than inheriting the loosest thing its neighbours needed.
 */
function requirePermission(scope) {
  return (req, res, next) => {
    resolveAuth(req).then((auth) => {
      if (!auth) return res.status(401).json({ error: 'Authentication required' });
      if (welcomeRefused(req, res, auth)) return;
      req.auth = auth;
      if (callerHasScope(auth, scope)) return next();
      return res.status(403).json({
        error: `This action needs the "${scope}" permission.`,
        code: 'insufficient_scope',
        required: scope
      });
    }).catch((err) => res.status(500).json({ error: err.message }));
  };
}

/**
 * Check a permission on a caller already resolved by `requireAdmin`. For the
 * person-only surfaces (settings, backups, notifications, setup), where keys stay
 * excluded but a viewer must not get an owner's reach.
 */
function permit(scope) {
  return (req, res, next) => {
    if (callerHasScope(req.auth, scope)) return next();
    return res.status(403).json({
      error: `This action needs the "${scope}" permission.`,
      code: 'insufficient_scope',
      required: scope
    });
  };
}

module.exports = {
  welcomeRefused,
  resolveAuth, requireAdmin, requireScope, requirePermission, permit,
  tokenHasScope, tokenAllowsApp, grantedScopes, callerHasScope
};
