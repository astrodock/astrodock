'use strict';

// The mobile app's API, discovery, and the Notify API. See MOBILE_DESIGN.md.
//
//   GET    /.well-known/astrodock.json        discovery, no auth, CORS *
//   GET    /mobile/authorize                  PKCE sign-in, on the hosted sign-in page
//   POST   /mobile/token                      code + verifier → device token
//   GET    /mobile/apps                       the person's apps
//   POST   /mobile/ticket                     a one-time link that opens an app in a WebView
//   GET    /mobile/open                       redeems it: platform session, then the app
//   GET    /mobile/device, DELETE             this device; DELETE is Sign Out
//   PUT    /mobile/push, DELETE               the relay handle and the device's public key
//   GET    /mobile/notifications              the inbox
//   POST   /mobile/notifications/:id/read, /read-all
//   POST   /notify                            an app's server sends someone a notification
//
// Every /mobile/* route but authorize and open takes `Authorization: Bearer adt_…`.
// Mounted at the root, like /authorize. Served on the auth host only (Caddy's
// AUTH_PATHS); /notify is reached on the internal address and has no route.

const express = require('express');
const crypto = require('crypto');
const { and, eq, inArray, asc } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const mobile = require('../lib/mobile');
const push = require('../lib/push');
const roles = require('../lib/roles');
const userSession = require('../lib/user-session');
const google = require('../lib/google');
const { decryptSecret } = require('../lib/crypto');
const { appUrl } = require('../lib/env-compute');
const { errorPage } = require('../lib/auth-pages');
const { emitEvent } = require('../lib/events');
const { pageLoginLimiter, mobileTokenLimiter, notifyLimiter } = require('../middleware/rateLimiter');
const { loginPage } = require('./oauth')._internal;

const router = express.Router();

// The platform has no name setting yet; MOBILE_DESIGN.md says to fall back to this.
const PLATFORM_NAME = 'Astrodock';

function logAttempt(email, appId, result, ip) {
  db.insert(schema.authLogs).values({ email: email || '', appId: appId || '', result, ip: ip || '' }).catch(() => {});
}

// Same compare /token uses.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function appBySlug(slug) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.slug, String(slug || ''))).limit(1);
  return rows[0] || null;
}

const userJson = (u) => ({ id: u.id, email: u.email, name: u.name });

// ── discovery ────────────────────────────────────────────────────────────────
// What the app reads before anything else, to learn this server's sign-in host
// and relay. Excluded from the CORS middleware in server.js: it is public, and
// answers any origin.
router.get('/.well-known/astrodock.json', async (req, res, next) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    const relay = await push.relay();
    res.json({
      astrodock: 1,
      name: PLATFORM_NAME,
      version: require('../lib/version').resolve().version,
      baseDomain: config.baseDomain,
      authUrl: config.authBaseUrl(),
      mobile: { enabled: await mobile.enabled() },
      push: relay ? { relayUrl: relay.url, serverId: relay.serverId } : null
    });
  } catch (err) { next(err); }
});

// ── the off switch ───────────────────────────────────────────────────────────
// With mobile.enabled off every /mobile/* route is a 404, which the app reads
// as "this server does not have the mobile app".
router.use('/mobile', async (req, res, next) => {
  try {
    if (await mobile.enabled()) return next();
    if (req.path === '/authorize' || req.path === '/open') {
      return res.status(404).type('html').send(errorPage('Not Found', 'This server does not offer the mobile app.'));
    }
    return res.status(404).json({ error: 'Not found.' });
  } catch (err) { next(err); }
});

// ── sign-in ──────────────────────────────────────────────────────────────────

router.get('/mobile/authorize', pageLoginLimiter, async (req, res, next) => {
  try {
    const { code_challenge: codeChallenge, code_challenge_method: method, redirect_uri: redirectUri } = req.query;
    const state = String(req.query.state || '').slice(0, 512);

    // The only place a code can go. Exact match, as for an app's redirect.
    if (redirectUri !== mobile.REDIRECT_URI) {
      return res.status(400).type('html').send(errorPage('Redirect URL Not Allowed',
        'This sign-in did not come from the Astrodock app.'));
    }
    if (method !== 'S256' || !mobile.validChallenge(codeChallenge)) {
      return res.status(400).type('html').send(errorPage('Start Again from the App',
        'That sign-in request is not valid.'));
    }
    res.setHeader('Cache-Control', 'no-store');

    // Already signed in to the platform: no new trust decision, so hand back a
    // code straight away. prompt=login forces the form, as on /authorize.
    const session = userSession.read(req);
    if (session && req.query.prompt !== 'login') {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.sub)).limit(1);
      if (user && user.isActive) {
        const code = await mobile.issueCode({ userId: user.id, codeChallenge });
        logAttempt(user.email, 'mobile', 'SUCCESS_SSO', req.ip || '');
        return res.redirect(mobile.redirectFor(code, state));
      }
    }

    res.type('html').send(loginPage({
      appName: PLATFORM_NAME,
      appId: '',
      redirectUri: '',
      state,
      nonce: '',
      brandColor: '',
      logoUrl: '',
      signedInAs: session?.email || '',
      googleEnabled: await google.configured().catch(() => false),
      mobile: { codeChallenge, state }
    }));
  } catch (err) { next(err); }
});

router.post('/mobile/token', mobileTokenLimiter, async (req, res, next) => {
  const { code, code_verifier: verifier, device } = req.body || {};
  try {
    // Checked before the code is spent, so a malformed request from a bug in
    // the app does not cost the person their sign-in.
    const cleaned = mobile.cleanDevice(device);
    const user = await mobile.redeemCode({ code, verifier });
    const { device: row, token } = await mobile.createDevice({ userId: user.id, device: cleaned });
    logAttempt(user.email, 'mobile', 'DEVICE_SIGNED_IN', req.ip || '');
    emitEvent({
      category: 'auth', type: 'mobile.device_signed_in', severity: 'info',
      actorType: 'user', actor: user.email, targetType: 'user', targetId: user.id, ip: req.ip || '',
      message: `${user.email} signed in on ${row.name || 'a phone'} (${row.platform})`,
      meta: { deviceId: row.id, platform: row.platform, appVersion: row.appVersion }
    }).catch(() => {});
    res.json({ deviceId: row.id, deviceToken: token, user: userJson(user) });
  } catch (err) {
    if (err instanceof mobile.MobileError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── the device's own routes ──────────────────────────────────────────────────

async function requireDevice(req, res, next) {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const found = m ? await mobile.authenticate(m[1]) : null;
    if (!found) return res.status(401).json({ error: 'Sign in again.' });
    req.device = found.device;
    req.user = found.user;
    next();
  } catch (err) { next(err); }
}

router.get('/mobile/apps', requireDevice, async (req, res, next) => {
  try {
    const access = Array.isArray(req.user.appAccess) ? req.user.appAccess.map(String) : [];
    const apps = access.length
      ? await db.select().from(schema.apps)
        .where(and(inArray(schema.apps.slug, access), eq(schema.apps.provisioned, true)))
        .orderBy(asc(schema.apps.name))
      : [];
    res.json({
      user: userJson(req.user),
      apps: apps.map((a) => ({
        slug: a.slug,
        name: a.name,
        description: a.description || '',
        url: appUrl(a),
        logoUrl: a.logoUrl || '',
        brandColor: a.brandColor || '',
        authMode: a.authMode
      })),
      ...(roles.isOperator(req.user) ? { admin: { url: mobile.adminUrl() } } : {})
    });
  } catch (err) { next(err); }
});

router.post('/mobile/ticket', requireDevice, async (req, res, next) => {
  try {
    const { app: slug, path } = req.body || {};
    if (path !== undefined && path !== null && path !== '' && !mobile.validPath(path)) {
      return res.status(400).json({ error: 'path must start with a single /.' });
    }
    const app = await appBySlug(slug);
    if (!app || !app.provisioned) return res.status(404).json({ error: 'There is no app by that name.' });
    if (!mobile.hasAccess(req.user, app)) return res.status(403).json({ error: 'You do not have access to this app.' });
    const ticket = await mobile.issueTicket({ device: req.device, app, path: path || null });
    res.json({ url: `${config.authBaseUrl()}/mobile/open?ticket=${encodeURIComponent(ticket)}` });
  } catch (err) { next(err); }
});

// Loaded by the WebView, so the answers are pages, not JSON. The ticket is the
// credential; there is no bearer token here.
router.get('/mobile/open', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { user, app, path } = await mobile.redeemTicket(req.query.ticket);
    userSession.set(res, user);
    logAttempt(user.email, app.slug, 'SUCCESS_MOBILE', req.ip || '');

    // As POST /launch: a public app needs no sign-in, so it opens directly (at
    // the path, when there is one). Any other app goes to its own sign-in, which
    // finds the platform session and completes without a form; `next` tells it
    // where to land.
    if (app.authMode === 'public') return res.redirect(303, `${appUrl(app)}${path || ''}`);
    const login = app.authLoginPath || '/api/login';
    const target = path
      ? `${appUrl(app)}${login}${login.includes('?') ? '&' : '?'}next=${encodeURIComponent(path)}`
      : `${appUrl(app)}${login}`;
    res.redirect(303, target);
  } catch (err) {
    if (!(err instanceof mobile.MobileError)) return next(err);
    const title = err.status === 403 ? 'No Access' : (err.status === 401 ? 'Sign In Again' : 'Cannot Open This App');
    res.status(err.status).type('html')
      .send(errorPage(title, err.message, { icon: err.status === 403 ? 'lock' : 'alert' }));
  }
});

router.get('/mobile/device', requireDevice, (req, res) => {
  res.json(mobile.publicDevice(req.device));
});

// The app's Sign Out.
router.delete('/mobile/device', requireDevice, async (req, res, next) => {
  try {
    await mobile.revokeDevice({ userId: req.user.id, deviceId: req.device.id });
    emitEvent({
      category: 'auth', type: 'mobile.device_revoked', severity: 'info',
      actorType: 'user', actor: req.user.email, targetType: 'user', targetId: req.user.id, ip: req.ip || '',
      message: `${req.user.email} signed out on ${req.device.name || 'a phone'}`,
      meta: { deviceId: req.device.id, by: 'device' }
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.put('/mobile/push', requireDevice, async (req, res, next) => {
  try {
    await mobile.setPush(req.device.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof mobile.MobileError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/mobile/push', requireDevice, async (req, res, next) => {
  try {
    await mobile.clearPush(req.device.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── the inbox ────────────────────────────────────────────────────────────────

router.get('/mobile/notifications', requireDevice, async (req, res, next) => {
  try {
    res.json(await mobile.listNotifications(req.user.id, { before: req.query.before, limit: req.query.limit }));
  } catch (err) {
    if (err instanceof mobile.MobileError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/mobile/notifications/read-all', requireDevice, async (req, res, next) => {
  try {
    await mobile.markAllRead(req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/mobile/notifications/:id/read', requireDevice, async (req, res, next) => {
  try {
    if (!await mobile.markRead(req.user.id, req.params.id)) return res.status(404).json({ error: 'No such notification.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── the Notify API ───────────────────────────────────────────────────────────
// An app's server tells one of its people something. Authenticated with the app
// secret exactly as POST /token is. Stored first, answered, then pushed: the
// inbox row is the notification, and a relay that is slow or down must not make
// the app's request fail or wait.

async function authenticateNotify(req, res, next) {
  try {
    const b = req.body || {};
    const app = await appBySlug(b.app_id);
    if (!app) return res.status(400).json({ error: 'Unknown app.' });
    if (!b.app_secret || !safeEqual(decryptSecret(app.appSecret), b.app_secret)) {
      return res.status(401).json({ error: 'Invalid app secret.' });
    }

    let user = null;
    if (b.user_id) {
      if (/^[0-9a-f-]{36}$/i.test(String(b.user_id))) {
        [user] = await db.select().from(schema.users).where(eq(schema.users.id, String(b.user_id))).limit(1);
      }
    } else if (b.email) {
      [user] = await db.select().from(schema.users)
        .where(eq(schema.users.email, String(b.email).toLowerCase().trim())).limit(1);
    } else {
      return res.status(400).json({ error: 'user_id or email is required.' });
    }
    // One answer for no such person, a disabled one, and one without access, so
    // an app cannot use this to learn who has accounts elsewhere on the platform.
    if (!user || !user.isActive || !mobile.hasAccess(user, app)) {
      return res.status(403).json({ error: 'That person does not have access to this app.' });
    }

    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const body = b.body == null ? '' : (typeof b.body === 'string' ? b.body : null);
    if (!title) return res.status(400).json({ error: 'title is required.' });
    if (title.length > push.TITLE_MAX) return res.status(400).json({ error: `title must be at most ${push.TITLE_MAX} characters.` });
    if (body === null) return res.status(400).json({ error: 'body must be a string.' });
    if (body.length > push.BODY_MAX) return res.status(400).json({ error: `body must be at most ${push.BODY_MAX} characters.` });
    const path = b.path == null || b.path === '' ? null : b.path;
    if (path !== null && !mobile.validPath(path)) return res.status(400).json({ error: 'path must start with a single /.' });

    req.notify = { app, user, title, body, path };
    next();
  } catch (err) { next(err); }
}

router.post('/notify', authenticateNotify, notifyLimiter, async (req, res, next) => {
  try {
    const { app, user, title, body, path } = req.notify;
    const row = await push.store({ userId: user.id, app, title, body, path });
    res.json({ id: row.id });
    push.pushNotification(row, app).catch(() => {});
  } catch (err) { next(err); }
});

module.exports = router;
