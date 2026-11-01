'use strict';

// What happens after someone presses send.
//
// Both of these run detached. A person reporting a bug gets their confirmation
// the moment the row exists; whether a model was reachable, or whether the
// developer's webhook endpoint is up, is not their problem and must never be
// the reason a submission appears to fail.

const fb = require('./feedback');
const netGuard = require('./net-guard');

const WEBHOOK_TIMEOUT_MS = 5000;

// This URL comes from an app's own app.json, and the control plane sits inside
// the compose network where `postgres`, `objectstore` and `runner` all answer to
// their service names. net-guard checks the address after DNS resolution and does
// not follow redirects, so neither a private name nor a public URL that bounces
// to one gets a request out of the platform on an app author's behalf.

/** HTTPS, and not pointed at something inside the perimeter (before DNS). */
function isPublicHttps(value) {
  return netGuard.checkUrl(value, { httpsOnly: true }).ok;
}

/**
 * The developer's own hook.
 *
 * This is the seam for someone whose process lives somewhere else: take the
 * intake and the storage, run your own triage, mirror it into whatever tracker
 * you already have. It gets the item and its context, never an internal note,
 * because at this point there are none and because it is an outbound call to a
 * URL an app author chose.
 */
async function fireWebhook(item, app) {
  const config = fb.configFor(app);
  if (!config.webhook) return false;
  if (!isPublicHttps(config.webhook)) return false;

  const res = await netGuard.postJson(config.webhook, {
    event: 'feedback.created',
    app: app.slug,
    feedback: {
      key: item.key,
      title: item.title,
      body: item.body,
      category: item.category,
      status: item.status,
      context: item.context,
      createdAt: item.createdAt
    }
  }, { timeoutMs: WEBHOOK_TIMEOUT_MS, httpsOnly: true });
  // A developer's endpoint being down is not our problem.
  return res.ok || res.status > 0;
}

/**
 * Everything that happens after a submission, detached from the response.
 *
 * Exported and awaited only by tests. The route calls it without awaiting.
 */
async function afterSubmit(item, app) {
  const results = { webhook: false, triaged: false };
  results.webhook = await fireWebhook(item, app).catch(() => false);
  try {
    const ai = require('./feedback-ai');
    results.triaged = !!(await ai.triage(item, app));
  } catch { /* triage is best-effort, always */ }
  return results;
}

/** Fire and forget, for the request path. */
function schedule(item, app) {
  afterSubmit(item, app).catch(() => {});
}

module.exports = { afterSubmit, fireWebhook, schedule, isPublicHttps, WEBHOOK_TIMEOUT_MS };
