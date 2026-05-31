const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AuthLog = require('../models/AuthLog');
const { accountLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function logAttempt(email, result, ip) {
  const ts = new Date().toISOString();
  console.log(`[account] ${ts} | ${result} | email=${email} | ip=${ip}`);
  AuthLog.create({ email, appId: 'account', result, ip }).catch(() => {});
}

router.post('/change-password', accountLimiter, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'email, currentPassword, and newPassword are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !user.isActive) {
    logAttempt(email, user ? 'INACTIVE_USER' : 'USER_NOT_FOUND', ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordValid) {
    logAttempt(email, 'PASSWORD_CHANGE_BAD_PASSWORD', ip);
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();

  logAttempt(email, 'PASSWORD_CHANGED', ip);

  res.json({ message: 'Password updated successfully' });
});

module.exports = router;
