'use strict';

// Scoped API tokens (the agent surface). Management is admin-JWT only.
// Tokens may carry app/deploy scopes but never user-management scope.

const express = require('express');
const { eq, desc } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { generateApiToken, hashToken } = require('../lib/ids');

const router = express.Router();
router.use(requireAdmin);

const ALLOWED_SCOPES = ['deploy', '*'];
const FORBIDDEN_SCOPES = ['users']; // never grantable to a token

router.get('/', async (req, res) => {
  const rows = await db.select({
    id: schema.apiTokens.id, name: schema.apiTokens.name, scopes: schema.apiTokens.scopes,
    appScope: schema.apiTokens.appScope,
    lastUsedAt: schema.apiTokens.lastUsedAt, createdAt: schema.apiTokens.createdAt
  }).from(schema.apiTokens).orderBy(desc(schema.apiTokens.createdAt));
  res.json({ tokens: rows });
});

router.post('/', async (req, res) => {
  const { name, scopes, apps } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ['deploy'];
  if (requested.some((s) => FORBIDDEN_SCOPES.includes(s))) {
    return res.status(400).json({ error: 'API tokens cannot be granted user-management scope' });
  }
  if (requested.some((s) => !ALLOWED_SCOPES.includes(s))) {
    return res.status(400).json({ error: `Unknown scope. Allowed: ${ALLOWED_SCOPES.join(', ')}` });
  }
  // optional per-app restriction: [] = all apps
  const appScope = Array.isArray(apps) ? apps.filter((s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s)) : [];

  const raw = generateApiToken();
  const rows = await db.insert(schema.apiTokens).values({ name, tokenHash: hashToken(raw), scopes: requested, appScope }).returning();
  res.status(201).json({
    token: raw, // shown ONCE
    id: rows[0].id, name: rows[0].name, scopes: rows[0].scopes, appScope: rows[0].appScope,
    note: appScope.length
      ? `Copy this token now — it will not be shown again. Scoped to: ${appScope.join(', ')}.`
      : 'Copy this token now — it will not be shown again.'
  });
});

router.delete('/:id', async (req, res) => {
  const rows = await db.delete(schema.apiTokens).where(eq(schema.apiTokens.id, req.params.id)).returning();
  if (!rows[0]) return res.status(404).json({ error: 'Token not found' });
  res.status(204).end();
});

module.exports = router;
