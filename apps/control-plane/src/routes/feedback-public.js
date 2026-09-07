'use strict';

// Feedback intake: the surface an app's users actually touch.
//
// This is the one route in the platform reachable from a stranger's browser with
// no operator credential, so it is deliberately narrow:
//
//   ORIGIN, NOT WILDCARD. CORS is answered only for the app's own pages: its
//   platform subdomain and any custom domain that finished verification. A
//   domain someone merely claimed is not one of them.
//
//   IDENTITY COMES FROM THE APP, NOT THE FORM. The platform generates each app's
//   ASTRODOCK_APP_JWT_SECRET and injects it, so it holds the same key the app
//   signs its own sessions with and can verify a token the app issued. An email
//   typed into the form is contact information, never identity: anyone can type
//   an address. Only a verified token satisfies an app that has not opted into
//   anonymous feedback.
//
//   NOTHING COMES BACK OUT. A submission returns its key and nothing else, and
//   the read route returns redactForUser() output. There is no path here that
//   can reach an internal note.

const express = require('express');
const jwt = require('jsonwebtoken');
const { and, eq, desc } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const fb = require('../lib/feedback');
const { decryptSecret } = require('../lib/crypto');
const { feedbackLimiter } = require('../middleware/rateLimiter');
const { widgetSource } = require('../lib/feedback-widget');

const router = express.Router();

async function loadApp(slug) {
  const [app] = await db.select().from(schema.apps)
    .where(eq(schema.apps.slug, String(slug || '').toLowerCase())).limit(1);
  return app || null;
}

async function originsFor(app) {
  const domains = await db.select().from(schema.customDomains)
    .where(eq(schema.customDomains.appId, app.id));
  return fb.originsFor(app, domains, config.baseDomain);
}

/**
 * Answer CORS for this app's own pages only.
 * Returns true when the request may proceed.
 */
async function cors(req, res, app) {
  const origin = req.headers.origin || '';
  const allowed = await originsFor(app);
  if (origin && !allowed.includes(origin)) return false;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  }
  return true;
}

/**
 * A person the app has vouched for, or null.
 *
 * The signature is what matters: it proves the app issued this. The payload
 * shape is the app's own, so read the fields an app is likely to have used and
 * do not insist on any of them. `sub` is treated as a platform user id only when
 * it looks like one; an app with its own user table still gets a verified email.
 */
function verifyIdentity(token, app) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, decryptSecret(app.appJwtSecret));
  } catch {
    return null;   // an unverifiable token is not an identity, it is a stranger
  }
  const sub = String(payload.sub || payload.userId || payload.id || '');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub);
  return {
    userId: isUuid ? sub : null,
    email: String(payload.email || '').toLowerCase().slice(0, fb.LIMITS.email),
    subject: sub
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return String((req.body && req.body.identity) || '');
}

// The widget. Served from the platform so an app gets it with one script tag and
// never has a stale copy of its own.
router.get('/widget.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(widgetSource());
});

router.options('/:slug', async (req, res) => {
  const app = await loadApp(req.params.slug);
  if (!app) return res.sendStatus(404);
  if (!(await cors(req, res, app))) return res.sendStatus(403);
  return res.sendStatus(204);
});

// What the widget needs to render itself: the categories this app uses, and
// whether it will take anything from someone who is not signed in.
router.get('/:slug/config', async (req, res) => {
  const app = await loadApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  if (!(await cors(req, res, app))) return res.status(403).json({ error: 'Origin not allowed' });
  const c = fb.configFor(app);
  res.json({ enabled: c.enabled, widget: c.widget, anonymous: c.anonymous, categories: c.categories });
});

router.post('/:slug', feedbackLimiter, async (req, res) => {
  const app = await loadApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  if (!(await cors(req, res, app))) return res.status(403).json({ error: 'Origin not allowed' });

  const identity = verifyIdentity(bearer(req), app);
  const body = req.body || {};
  try {
    const row = await fb.submit({
      app,
      identity,
      title: body.title,
      body: body.body || body.message || body.description,
      category: body.category,
      email: body.email,
      context: { ...(body.context || {}), userAgent: req.headers['user-agent'] || '' }
    });
    // The key, and nothing else. It is what a person quotes back at you.
    res.status(201).json({ key: row.key, status: row.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Someone's own feedback and the replies to it. Requires a verified identity:
// there is no version of this that takes an email and trusts it.
router.get('/:slug/mine', async (req, res) => {
  const app = await loadApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  if (!(await cors(req, res, app))) return res.status(403).json({ error: 'Origin not allowed' });

  const identity = verifyIdentity(bearer(req), app);
  if (!identity) return res.status(401).json({ error: 'Sign in to see your feedback.' });

  const where = identity.userId
    ? and(eq(schema.feedback.appId, app.id), eq(schema.feedback.submittedBy, identity.userId))
    : and(eq(schema.feedback.appId, app.id), eq(schema.feedback.submitterEmail, identity.email));
  if (!identity.userId && !identity.email) return res.json({ items: [] });

  const rows = await db.select().from(schema.feedback).where(where)
    .orderBy(desc(schema.feedback.createdAt)).limit(50);

  const items = [];
  for (const row of rows) {
    items.push(fb.redactForUser(row, await fb.messages(row.id, { visibility: 'user' })));
  }
  res.json({ items });
});

module.exports = router;
module.exports.verifyIdentity = verifyIdentity;
