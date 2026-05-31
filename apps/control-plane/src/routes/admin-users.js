'use strict';

const express = require('express');
const { eq, asc } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../lib/passwords');

const router = express.Router();
router.use(requireAdmin); // user management is admin-JWT only — never scoped tokens

function publicUser(u) {
  if (!u) return u;
  const { passwordHash, ...rest } = u;
  return rest;
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
router.post('/', async (req, res) => {
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
router.patch('/:id', async (req, res) => {
  const { name, isActive, isAdmin } = req.body || {};
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (isActive !== undefined) update.isActive = isActive;
  if (isAdmin !== undefined) update.isAdmin = isAdmin;

  const rows = await db.update(schema.users).set(update).where(eq(schema.users.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(rows[0]) });
});

// Delete
router.delete('/:id', async (req, res) => {
  const rows = await db.delete(schema.users).where(eq(schema.users.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});

// Reset password
router.post('/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  const passwordHash = await hashPassword(newPassword);
  const rows = await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});

// Grant app access
router.put('/:id/access/:appSlug', async (req, res) => {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const access = new Set(Array.isArray(user.appAccess) ? user.appAccess : []);
  access.add(req.params.appSlug);
  await db.update(schema.users).set({ appAccess: [...access], updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  res.status(204).end();
});

// Revoke app access
router.delete('/:id/access/:appSlug', async (req, res) => {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).limit(1);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const access = (Array.isArray(user.appAccess) ? user.appAccess : []).filter((s) => s !== req.params.appSlug);
  await db.update(schema.users).set({ appAccess: access, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  res.status(204).end();
});

module.exports = router;
