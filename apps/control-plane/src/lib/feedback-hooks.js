'use strict';

// What happens after someone presses send.
//
// Both of these run detached. A person reporting a bug gets their confirmation
// the moment the row exists; whether a model was reachable, or whether the
// developer's webhook endpoint is up, is not their problem and must never be
// the reason a submission appears to fail.

const fb = require('./feedback');

const WEBHOOK_TIMEOUT_MS = 5000;

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
  let url;
  try {
    url = new URL(config.webhook);
    // No plaintext, and no talking to the loopback or the metadata service on
    // behalf of an app author's config value.
    if (url.protocol !== 'https:') return false;
  } catch { return false; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
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
      })
    });
    return true;
  } catch {
    return false;      // a developer's endpoint being down is not our problem
  } finally {
    clearTimeout(timer);
  }
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

module.exports = { afterSubmit, fireWebhook, schedule, WEBHOOK_TIMEOUT_MS };
