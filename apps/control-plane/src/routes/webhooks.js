'use strict';

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const { verifyWebhookSignature } = require('../lib/github');
const { decryptSecret } = require('../lib/crypto');
const { runner } = require('../runner/client');

const router = express.Router();

// GitHub sends JSON; we need the raw body for signature verification, so this
// route is mounted BEFORE express.json() in server.js.
// Recent delivery ids, in memory. GitHub retries with the same id, so a repeat
// within a day is a duplicate whether it came from GitHub or from a replay.
const seen = new Map();
const SEEN_TTL_MS = 24 * 3600 * 1000;
function seenDelivery(id) {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(k); else break;
  if (seen.has(id)) return true;
  seen.set(id, now);
  if (seen.size > 5000) seen.delete(seen.keys().next().value);
  return false;
}

router.post('/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) return res.status(400).json({ error: 'Missing repository info' });

  // Every app linked to the repository, and the one whose own webhook secret
  // signed this delivery. Taking the first app by repository meant a second app
  // connected to the same repository took the deliveries meant for the first.
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.githubRepo, repoFullName));
  if (!rows.length) return res.status(404).json({ error: 'No app linked to this repository' });
  const app = rows.find((a) => verifyWebhookSignature(req.body, signature, decryptSecret(a.webhookSecret)));
  if (!app) return res.status(401).json({ error: 'Invalid signature' });

  // A signed delivery is accepted once. Replaying a captured one used to start
  // another deploy each time.
  const delivery = String(req.headers['x-github-delivery'] || '');
  if (delivery) {
    if (seenDelivery(delivery)) return res.json({ message: 'Already handled this delivery' });
  }

  if (event !== 'push') return res.json({ message: `Ignored event: ${event}` });

  const branch = payload.ref?.replace('refs/heads/', '');
  if (branch !== app.branch) {
    return res.json({ message: `Ignored push to ${branch} (watching ${app.branch})` });
  }

  const head = payload.head_commit;
  const commitHash = head?.id?.substring(0, 7) || '';
  const commitMessage = head?.message?.split('\n')[0] || '';

  runner.deploy(app.slug, { trigger: 'webhook', commitHash, commitMessage }).catch((err) => {
    console.error(`Deploy failed for ${app.slug}:`, err.message);
  });

  res.json({ message: 'Deploy triggered', appSlug: app.slug });
});

module.exports = router;
