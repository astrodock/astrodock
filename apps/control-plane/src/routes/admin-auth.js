const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { adminLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !user.isActive || !user.isAdmin) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { sub: user._id.toString(), email: user.email, isAdmin: true },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name
    }
  });
});

module.exports = router;
