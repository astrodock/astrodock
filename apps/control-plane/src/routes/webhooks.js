const express = require('express');
const App = require('../models/App');
const { verifyWebhookSignature } = require('../lib/github');
const { runDeploy } = require('../lib/deploy');

const router = express.Router();

// GitHub sends JSON but we need the raw body for signature verification
router.post('/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];

  if (!signature) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  // We don't know which app this is for yet, so parse the payload first
  let payload;
  try {
    payload = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return res.status(400).json({ error: 'Missing repository info' });
  }

  // Find the app by repo name
  const app = await App.findOne({ githubRepo: repoFullName });
  if (!app) {
    return res.status(404).json({ error: 'No app linked to this repository' });
  }

  // Verify the webhook signature
  if (!verifyWebhookSignature(req.body, signature, app.webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Only handle push events to the configured branch
  if (event !== 'push') {
    return res.json({ message: `Ignored event: ${event}` });
  }

  const branch = payload.ref?.replace('refs/heads/', '');
  if (branch !== app.branch) {
    return res.json({ message: `Ignored push to ${branch} (watching ${app.branch})` });
  }

  // Get commit info from the push payload
  const headCommit = payload.head_commit;
  const commitHash = headCommit?.id?.substring(0, 7) || '';
  const commitMessage = headCommit?.message?.split('\n')[0] || '';

  // Trigger deploy asynchronously — don't block the webhook response
  runDeploy(app, { trigger: 'webhook', commitHash, commitMessage }).catch(err => {
    console.error(`Deploy failed for ${app.slug}:`, err);
  });

  res.json({ message: 'Deploy triggered', appSlug: app.slug });
});

module.exports = router;
