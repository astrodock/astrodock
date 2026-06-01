'use strict';

const express = require('express');
const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { verifyPassword } = require('../lib/passwords');
const { decryptSecret } = require('../lib/crypto');
const { verifyLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// constant-time string compare (length check first; secrets are fixed-format high-entropy)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function logAttempt(email, appId, result, ip) {
  console.log(`[verify] ${new Date().toISOString()} | ${result} | app=${appId} | email=${email} | ip=${ip}`);
  db.insert(schema.authLogs).values({ email, appId, result, ip: ip || '' }).catch(() => {});
}

// POST /verify — an app asks "are these end-user credentials valid for me?"
// Result codes preserved from the original platform so the auth-client contract is unchanged.
router.post('/', verifyLimiter, async (req, res) => {
  const { email, password, appId, appSecret, clientIp } = req.body || {};
  const ip = clientIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !password || !appId || !appSecret) {
    return res.status(400).json({ error: 'email, password, appId, and appSecret are required' });
  }

  const appRows = await db.select().from(schema.apps).where(eq(schema.apps.slug, appId)).limit(1);
  const app = appRows[0];
  if (!app || !safeEqual(decryptSecret(app.appSecret), appSecret)) {
    logAttempt(email, appId, 'INVALID_APP_SECRET', ip);
    return res.status(401).json({ error: 'Invalid app credentials' });
  }

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.email, String(email).toLowerCase().trim())).limit(1);
  const user = userRows[0];
  if (!user || !user.isActive) {
    logAttempt(email, appId, user ? 'INACTIVE_USER' : 'USER_NOT_FOUND', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    logAttempt(email, appId, 'BAD_PASSWORD', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const access = Array.isArray(user.appAccess) ? user.appAccess : [];
  if (!access.includes(appId)) {
    logAttempt(email, appId, 'NO_ACCESS', ip);
    return res.status(403).json({ error: 'User does not have access to this app' });
  }

  logAttempt(email, appId, 'SUCCESS', ip);
  res.json({ userId: user.id, email: user.email, name: user.name });
});

module.exports = router;
