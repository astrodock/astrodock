'use strict';

const express = require('express');
const { eq, asc } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { hashPassword } = require('../lib/passwords');
const roles = require('../lib/roles');
const invites = require('../lib/invites');
const accountEmail = require('../lib/account-email');

const router = express.Router();
// Agent keys CAN manage end users now, but never operators — enforced per-request
// in guardTarget below, since the distinction is about the target, not the caller.
router.use(requirePermission('users:read'));

function publicUser(u) {
  if (!u) return u;
  const { passwordHash, totpSecret, totpLastStep, ...rest } = u;
  return { ...rest, isOperator: !!u.operatorRole, hasPassword: !!u.passwordHash };
}

/**
 * May this caller act on this target?
 *
 * Two separate rules, because a key and a person are limited differently:
 *   • a KEY may only touch end users, and never its own principal
 *   • a PERSON is bound by role — only an owner may change an owner
 */
function guardTarget(req, target) {
  if (req.auth.type === 'token') return roles.keyCanManageUser(req.auth, target);
  return roles.canManageUser({ role: req.auth.role }, target);
}

function refuse(res, verdict) {
  return res.status(403).json({ error: verdict.reason });
}

// List
router.get('/', async (req, res) => {
  const users = await db.select().from(schema.users).orderBy(asc(schema.users.name));
  res.json({ users: users.map(publicUser) });
});

// Get one
router.get('/:id', async (req, res) => {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(rows[0]) });
});

// Create
router.post('/', requirePermission('users:write'), async (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const normEmail = String(email).toLowerCase().trim();
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, normEmail)).limit(1);
  if (existing[0]) return res.status(409).json({ error: 'A user with this email already exists' });

  const passwordHash = await hashPassword(password);
  const rows = await db.insert(schema.users).values({ email: normEmail, name, passwordHash }).returning();
  res.status(201).json({ user: publicUser(rows[0]) });
});

// Invite
//
// The other way to make an end user, and the one to prefer. Creating an account
// through POST / means choosing a password for another person and then having
// to send it to them; this creates the account with no credential and no
// access, and hands back a single-use link so they can set up their own.
//
// The link is returned rather than emailed. Sending it is the app's job: an
// invite to Valise should arrive as an email from Valise, in Valise's voice,
// not as a generic message from the platform the app happens to run on.
router.post('/invite', requirePermission('users:write'), async (req, res) => {
  const { email, name, appId, invitedByName, redirectTo, ttlDays } = req.body || {};
  if (!email || !appId) return res.status(400).json({ error: 'email and appId are required' });

  const appRows = await db.select().from(schema.apps).where(eq(schema.apps.slug, String(appId))).limit(1);
  const app = appRows[0];
  if (!app) return res.status(404).json({ error: 'No app with that slug' });

  // A key is scoped to a set of apps; inviting someone into an app it has no
  // business touching is a privilege escalation with extra steps.
  if (req.auth.type === 'token') {
    const scope = Array.isArray(req.auth.appScope) ? req.auth.appScope : [];
    if (scope.length && !scope.includes(app.slug)) {
      return res.status(403).json({ error: 'This key is not scoped to that app.' });
    }
  }

  try {
    const r = await invites.create({
      email, name, app, invitedByName, redirectTo, ttlDays
    });
    // An operator is never created or elevated here, so there is no target to
    // guard: the worst an invite can do is give an existing end user access to
    // one more app, which is what users:write already means.
    res.status(201).json({
      url: r.url,
      expiresAt: r.invite.expiresAt,
      user: publicUser(r.user),
      existingUser: r.existingUser
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update
router.patch('/:id', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);

  const { name, isActive, operatorRole, email } = req.body || {};
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (isActive !== undefined) update.isActive = isActive;

  // The sign-in address. Previously unchangeable here and everywhere else, which
  // made a typo in an invite permanent — and the address is also what Google
  // linking matches on for a first sign-in, so a wrong one locked someone out of
  // the account they were invited to. Applied without a confirmation round trip
  // on purpose: the address is wrong precisely because nobody can read mail
  // there. A person changing their OWN address does have to prove it; that path
  // is in lib/account-email.
  if (email !== undefined && accountEmail.normalize(email) !== target.email) {
    try {
      await accountEmail.setByOperator({
        userId: target.id,
        newEmail: email,
        actor: req.auth.type === 'token' ? (req.auth.name || 'key') : (req.auth.email || 'operator')
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (operatorRole !== undefined) {
    // Granting dashboard access is a privilege change, so it is a person's call —
    // never a key's, whatever scopes it holds.
    if (req.auth.type === 'token') {
      return res.status(403).json({ error: 'Access keys cannot grant or change operator access.' });
    }
    if (operatorRole !== null && !roles.ROLES[operatorRole]) {
      return res.status(400).json({ error: `Unknown role. Choose one of: ${Object.keys(roles.ROLES).join(', ')}` });
    }
    if (operatorRole === 'owner' && req.auth.role !== 'owner') {
      return res.status(403).json({ error: 'Only an owner can make someone else an owner.' });
    }
    // Never remove the last owner: an install with none has nobody who can undo
    // anything, and no path back short of editing the database.
    if (target.operatorRole === 'owner' && operatorRole !== 'owner') {
      const all = await db.select({ role: schema.users.operatorRole }).from(schema.users);
      if (all.filter((u) => u.role === 'owner').length <= 1) {
        return res.status(400).json({ error: 'This is the only owner. Make someone else an owner first.' });
      }
    }
    update.operatorRole = operatorRole;
    update.isAdmin = !!operatorRole; // keep the legacy flag consistent
  }

  // Same reasoning for deactivation as for demotion.
  if (isActive === false && target.operatorRole === 'owner') {
    const all = await db.select({ role: schema.users.operatorRole, active: schema.users.isActive })
      .from(schema.users);
    if (all.filter((u) => u.role === 'owner' && u.active).length <= 1) {
      return res.status(400).json({ error: 'This is the only active owner.' });
    }
  }

  const rows = await db.update(schema.users).set(update).where(eq(schema.users.id, req.params.id)).returning();
  res.json({ user: publicUser(rows[0]) });
});

// Delete
router.delete('/:id', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);
  const rows = await db.delete(schema.users).where(eq(schema.users.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});

// Reset password
router.post('/:id/reset-password', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  const passwordHash = await hashPassword(newPassword);
  const rows = await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});

// Grant app access
router.put('/:id/access/:appSlug', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const access = new Set(Array.isArray(user.appAccess) ? user.appAccess : []);
  access.add(req.params.appSlug);
  await db.update(schema.users).set({ appAccess: [...access], updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  res.status(204).end();
});

// Revoke app access
router.delete('/:id/access/:appSlug', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const access = (Array.isArray(user.appAccess) ? user.appAccess : []).filter((s) => s !== req.params.appSlug);
  await db.update(schema.users).set({ appAccess: access, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  res.status(204).end();
});

module.exports = router;
