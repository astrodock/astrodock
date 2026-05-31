const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const App = require('../models/App');
const AuthLog = require('../models/AuthLog');
const { verifyLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function logAttempt(email, appId, result, ip) {
  const ts = new Date().toISOString();
  console.log(`[verify] ${ts} | ${result} | app=${appId} | email=${email} | ip=${ip}`);
  // Save to MongoDB (fire and forget)
  AuthLog.create({ email, appId, result, ip }).catch(() => {});
}

router.post('/', verifyLimiter, async (req, res) => {
  const { email, password, appId, appSecret, clientIp } = req.body;
  // Prefer clientIp passed by the app (original end-user IP), fall back to request IP
  const ip = clientIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !password || !appId || !appSecret) {
    return res.status(400).json({ error: 'email, password, appId, and appSecret are required' });
  }

  // Validate app and secret
  const app = await App.findOne({ slug: appId });
  if (!app || app.appSecret !== appSecret) {
    logAttempt(email, appId, 'INVALID_APP_SECRET', ip);
    return res.status(401).json({ error: 'Invalid app credentials' });
  }

  // Find user and validate password
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !user.isActive) {
    logAttempt(email, appId, user ? 'INACTIVE_USER' : 'USER_NOT_FOUND', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    logAttempt(email, appId, 'BAD_PASSWORD', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check app access
  if (!user.appAccess.includes(appId)) {
    logAttempt(email, appId, 'NO_ACCESS', ip);
    return res.status(403).json({ error: 'User does not have access to this app' });
  }

  logAttempt(email, appId, 'SUCCESS', ip);

  res.json({
    userId: user._id.toString(),
    email: user.email,
    name: user.name
  });
});

module.exports = router;
