'use strict';

const express = require('express');
const { eq, asc } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { hashPassword } = require('../lib/passwords');
const roles = require('../lib/roles');

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

// Update
router.patch('/:id', requirePermission('users:write'), async (req, res) => {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const verdict = guardTarget(req, target);
  if (!verdict.ok) return refuse(res, verdict);

  const { name, isActive, operatorRole } = req.body || {};
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (isActive !== undefined) update.isActive = isActive;

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
