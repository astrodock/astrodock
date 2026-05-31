const express = require('express');
const Deployment = require('../models/Deployment');
const AuthLog = require('../models/AuthLog');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();

router.use(requireAdmin);

// Recent deployments across all apps
router.get('/deployments', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const deployments = await Deployment.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-log');
  res.json({ deployments });
});

// Auth logs
router.get('/auth-logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const filter = {};

  if (req.query.result) filter.result = req.query.result;
  if (req.query.appId) filter.appId = req.query.appId;
  if (req.query.email) filter.email = new RegExp(req.query.email, 'i');

  const logs = await AuthLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ logs });
});

module.exports = router;
