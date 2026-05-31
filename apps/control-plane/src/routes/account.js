'use strict';

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { accountLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function logAttempt(email, result, ip) {
  console.log(`[account] ${new Date().toISOString()} | ${result} | email=${email} | ip=${ip}`);
  db.insert(schema.authLogs).values({ email, appId: 'account', result, ip: ip || '' }).catch(() => {});
}

// End-user self-service password change (used by the hosted /account page).
router.post('/change-password', accountLimiter, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'email, currentPassword, and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, String(email).toLowerCase().trim())).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) {
    logAttempt(email, user ? 'INACTIVE_USER' : 'USER_NOT_FOUND', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    logAttempt(email, 'PASSWORD_CHANGE_BAD_PASSWORD', ip);
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const passwordHash = await hashPassword(newPassword);
  await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  logAttempt(email, 'PASSWORD_CHANGED', ip);
  res.json({ message: 'Password updated successfully' });
});

module.exports = router;
