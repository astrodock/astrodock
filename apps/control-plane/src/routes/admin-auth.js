'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { verifyPassword } = require('../lib/passwords');
const { adminLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, String(email).toLowerCase().trim())).limit(1);
  const user = rows[0];
  if (!user || !user.isActive || !user.isAdmin) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { sub: user.id, email: user.email, isAdmin: true },
    config.adminJwtSecret,
    { expiresIn: '8h' }
  );

  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

module.exports = router;
