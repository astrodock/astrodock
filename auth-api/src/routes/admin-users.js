const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

// All routes require admin
router.use(requireAdmin);

// List all users
router.get('/', async (req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.json({ users });
});

// Get single user
router.get('/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// Create user
router.post('/', async (req, res) => {
  const { email, name, password } = req.body;

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'email, name, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ email, name, passwordHash });
  res.status(201).json({ user });
});

// Update user
router.patch('/:id', async (req, res) => {
  const { name, isActive, isAdmin } = req.body;
  const update = {};

  if (name !== undefined) update.name = name;
  if (isActive !== undefined) update.isActive = isActive;
  if (isAdmin !== undefined) update.isAdmin = isAdmin;

  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({ user });
});

// Delete user
router.delete('/:id', async (req, res) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});

// Reset password
router.post('/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const user = await User.findByIdAndUpdate(req.params.id, { passwordHash });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.status(204).end();
});

// Grant app access
router.put('/:id/access/:appSlug', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.appAccess.includes(req.params.appSlug)) {
    user.appAccess.push(req.params.appSlug);
    await user.save();
  }

  res.status(204).end();
});

// Revoke app access
router.delete('/:id/access/:appSlug', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.appAccess = user.appAccess.filter(slug => slug !== req.params.appSlug);
  await user.save();

  res.status(204).end();
});

module.exports = router;
