'use strict';

// "What am I, and what may I do?"
//
// Without this an agent discovers its own limits by collecting 403s, which is a
// slow and destructive way to learn. Answering directly means a well-behaved agent
// can check before acting, and explain to a person why it cannot do something.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { resolveAuth, grantedScopes } = require('../middleware/auth');
const { SCOPES } = require('../lib/scopes');
const roles = require('../lib/roles');

const router = express.Router();

router.get('/', async (req, res) => {
  const auth = await resolveAuth(req);
  if (!auth) return res.status(401).json({ error: 'Authentication required' });

  const scopes = grantedScopes(auth);
  const can = {};
  for (const s of scopes) can[s] = SCOPES[s] || s;

  if (auth.type === 'token') {
    let authorizedBy = null;
    if (auth.authorizedByUserId) {
      const [u] = await db.select({ email: schema.users.email }).from(schema.users)
        .where(eq(schema.users.id, auth.authorizedByUserId)).limit(1);
      authorizedBy = u ? u.email : null;
    }
    return res.json({
      kind: 'key',
      name: auth.name,
      scopes,
      can,
      // Empty means every app — stated explicitly rather than left to be inferred
      // from an absent field.
      apps: auth.appScope.length ? auth.appScope : 'all',
      expiresAt: auth.expiresAt,
      // Who this key acts for. Every action it takes is recorded against them.
      authorizedBy,
      canCreateKeys: scopes.includes('tokens:write'),
      notes: scopes.includes('tokens:write')
        ? 'Keys you create must have strictly fewer permissions than this one, and cannot themselves create keys.'
        : undefined
    });
  }

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, auth.sub)).limit(1);
  res.json({
    kind: 'person',
    email: auth.email,
    role: auth.role,
    roleLabel: (roles.ROLES[auth.role] || {}).label || auth.role,
    scopes,
    can,
    apps: 'all',
    // The other half of the identity: which APPS this person may sign in to is
    // independent of what they may do in the dashboard.
    appAccess: user ? (user.appAccess || []) : [],
    sessionId: auth.sessionId || null
  });
});

module.exports = router;
