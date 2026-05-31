'use strict';

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { verifyWebhookSignature } = require('../lib/github');
const { runDeploy } = require('../runner/deploy');

const router = express.Router();

// GitHub sends JSON; we need the raw body for signature verification, so this
// route is mounted BEFORE express.json() in server.js.
router.post('/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) return res.status(400).json({ error: 'Missing repository info' });

  const rows = await db.select().from(schema.apps).where(eq(schema.apps.githubRepo, repoFullName)).limit(1);
  const app = rows[0];
  if (!app) return res.status(404).json({ error: 'No app linked to this repository' });

  if (!verifyWebhookSignature(req.body, signature, app.webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (event !== 'push') return res.json({ message: `Ignored event: ${event}` });

  const branch = payload.ref?.replace('refs/heads/', '');
  if (branch !== app.branch) {
    return res.json({ message: `Ignored push to ${branch} (watching ${app.branch})` });
  }

  const head = payload.head_commit;
  const commitHash = head?.id?.substring(0, 7) || '';
  const commitMessage = head?.message?.split('\n')[0] || '';

  runDeploy(app, { trigger: 'webhook', commitHash, commitMessage }).catch((err) => {
    console.error(`Deploy failed for ${app.slug}:`, err.message);
  });

  res.json({ message: 'Deploy triggered', appSlug: app.slug });
});

module.exports = router;
