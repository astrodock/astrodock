'use strict';

// The event/audit spine. Every noteworthy thing — an app going down, a deploy
// failing, a page published, a setting changed — flows through emitEvent(), which
// (1) records an immutable row in `events` (the audit trail) and (2) routes the
// event to any matching notification rules (src/lib/notifications).
//
// Runs from BOTH processes: the control-plane (pages/audit events) and the runner
// (health/deploy events). Both share src/db and src/lib, so this module is neutral.
//
// emitEvent is awaitable through delivery — short-lived callers (the deploy worker)
// must `await` it before exiting; long-running callers (health monitor) fire-and-
// forget with `.catch(() => {})`.

const { db, schema } = require('../db');
const { route } = require('./notifications');

// Insert the audit row. Best-effort: a logging failure must never break the action
// that produced the event. Returns the new event id, or null on failure.
async function recordEvent(e) {
  const row = {
    category: e.category,
    type: e.type,
    severity: e.severity || 'info',
    actorType: e.actorType || 'system',
    actor: e.actor || 'system',
    targetType: e.targetType || '',
    targetId: e.targetId ? String(e.targetId) : '',
    appSlug: e.appSlug || '',
    ip: e.ip || '',
    message: e.message || '',
    meta: e.meta || {}
  };
  try {
    const [r] = await db.insert(schema.events).values(row).returning({ id: schema.events.id });
    return r ? r.id : null;
  } catch (err) {
    console.error('[events] record failed:', err.message);
    return null;
  }
}

// Emit a platform event: record it, then route it to matching notification rules.
async function emitEvent(e) {
  const id = await recordEvent(e);
  try { await route({ ...e, id }); }
  catch (err) { console.error('[events] route failed:', err.message); }
  return id;
}

// Map an authenticated request's `req.auth` to event actor fields.
function actorFromAuth(auth) {
  if (!auth) return { actorType: 'system', actor: 'system' };
  if (auth.type === 'admin') return { actorType: 'admin', actor: auth.email || 'admin' };
  if (auth.type === 'token') return { actorType: 'token', actor: auth.name || 'token' };
  return { actorType: 'system', actor: 'system' };
}

module.exports = { emitEvent, recordEvent, actorFromAuth };
