'use strict';

// What happens after someone presses send.
//
// Both of these run detached. A person reporting a bug gets their confirmation
// the moment the row exists; whether a model was reachable, or whether the
// developer's webhook endpoint is up, is not their problem and must never be
// the reason a submission appears to fail.

const fb = require('./feedback');

const WEBHOOK_TIMEOUT_MS = 5000;

// Hostnames the control plane must not be talked into calling.
//
// This URL comes from an app's own app.json, and the control plane sits inside
// the compose network where `postgres`, `objectstore` and `runner` all answer to
// their service names. Without this, "webhook": "http://objectstore:8333/…"
// is a request the platform makes on an app author's behalf, from inside the
// perimeter. The cloud metadata address is the same problem with a worse prize.
//
// A hostname check is not airtight: a public name can resolve to a private
// address, and only resolving it at request time would catch that. It stops the
// direct version, which is the one someone writes by accident.
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  'postgres', 'objectstore', 'runner', 'api', 'caddy',
  '169.254.169.254', 'metadata.google.internal'
]);

const PRIVATE_IP = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** HTTPS, and not pointed at something inside the perimeter. */
function isPublicHttps(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;      // never a user report in the clear
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) return false;
  if (PRIVATE_IP.test(host)) return false;
  // A bare name with no dot is a container or a search-domain lookup, never a
  // public endpoint.
  if (!host.includes('.') && !host.includes(':')) return false;
  return true;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(config.webhook, {
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

module.exports = { afterSubmit, fireWebhook, schedule, isPublicHttps, WEBHOOK_TIMEOUT_MS };
