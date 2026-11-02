'use strict';

// The relay's HTTP API (MOBILE_DESIGN.md section 7).
//
// node:http with a hand-rolled router: five routes do not need a framework.
// Errors are JSON `{ error }`. Device tokens, envelopes and secrets are never
// logged; each push logs one line with the server id, platform and outcome.

const http = require('node:http');
const ids = require('./ids');
const { createLimiter } = require('./rate-limit');
const { createClientIp } = require('./client-ip');
const { createApns } = require('./apns');
const { createFcm } = require('./fcm');

const BODY_LIMIT = 16 * 1024;

const DEFAULT_LIMITS = {
  registration: { max: 10, windowMs: 60 * 60 * 1000 }, // per IP
  subscriptions: { max: 60, windowMs: 60 * 1000 }, // per IP
  push: { max: 600, windowMs: 60 * 1000 } // per server
};

// What every device sees before the app decrypts the real text. Android keeps
// showing it in v1; the app reads the real text from the server's inbox.
const GENERIC = { title: 'New Notification', body: 'Open to read.' };

const PLATFORMS = new Set(['ios', 'android']);
const ENVIRONMENTS = new Set(['sandbox', 'production']);
const TOKEN_RE = {
  ios: /^[0-9a-fA-F]{64,200}$/,
  android: /^[A-Za-z0-9_:.-]{20,4096}$/
};
const PLATFORM_NAME = { ios: 'APNs', android: 'FCM' };

class HttpError extends Error {
  constructor(status, body) {
    super(body.error || 'gone');
    this.status = status;
    this.body = body;
  }
}
const fail = (status, error) => { throw new HttpError(status, { error }); };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  res.end(text);
}

// Reads at most BODY_LIMIT bytes. A larger body is refused without buffering
// the rest of it; the connection is closed after the 413 so the unread bytes
// cannot be taken for the next request.
function readJson(req, res) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      res.setHeader('connection', 'close');
      reject(new HttpError(413, { error: 'Request body is larger than 16 KB.' }));
    };
    if (Number(req.headers['content-length']) > BODY_LIMIT) return tooLarge();
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { done = true; tooLarge(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, { error: 'Request body must be a JSON object.' }));
      }
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

const isString = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;

function base64Length(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return -1;
  return Buffer.from(v, 'base64').length;
}

// The relay cannot read the envelope, but it checks the shape so a caller bug
// shows up here instead of as a notification the phone cannot open.
function parseEnvelope(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || e.v !== 1) return null;
  if (base64Length(e.e) !== 32 || base64Length(e.n) !== 12 || base64Length(e.c) < 16) return null;
  return { v: 1, e: e.e, n: e.n, c: e.c };
}

function validUrl(v) {
  if (!isString(v, 1, 500)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function createRelay({ config, store, limits = {}, log = (line) => console.log(line) }) {
  const apns = config.apns ? createApns(config.apns) : null;
  const fcm = config.fcm ? createFcm(config.fcm) : null;
  const clientIp = createClientIp(config.trustProxy);
  const limiters = {
    registration: createLimiter({ ...DEFAULT_LIMITS.registration, ...limits.registration }),
    subscriptions: createLimiter({ ...DEFAULT_LIMITS.subscriptions, ...limits.subscriptions }),
    push: createLimiter({ ...DEFAULT_LIMITS.push, ...limits.push })
  };

  const limit = (limiter, key) => {
    if (!limiter.hit(key)) fail(429, 'Too many requests. Try again later.');
  };

  // ── POST /v1/servers ────────────────────────────────────────────────────────
  async function registerServer(req, res) {
    limit(limiters.registration, clientIp.of(req));
    const body = await readJson(req, res);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isString(name, 1, 100)) fail(400, 'name is required (up to 100 characters).');
    if (!validUrl(body.url)) fail(400, 'url must be an http or https URL.');
    if (config.registration === 'code') {
      if (!config.registrationCode) fail(403, 'Registration is closed on this relay.');
      if (typeof body.registrationCode !== 'string' || !ids.safeEqual(body.registrationCode, config.registrationCode)) {
        fail(403, 'The registration code is wrong.');
      }
    }
    const serverId = ids.newServerId();
    const serverSecret = ids.newServerSecret();
    await store.createServer({ id: serverId, name, url: body.url, secretHash: ids.sha256(serverSecret) });
    log(`register server=${serverId}`);
    sendJson(res, 201, { serverId, serverSecret });
  }

  // ── POST /v1/subscriptions ──────────────────────────────────────────────────
  async function subscribe(req, res) {
    limit(limiters.subscriptions, clientIp.of(req));
    const body = await readJson(req, res);
    const { serverId, platform, environment, token } = body;
    if (typeof serverId !== 'string' || !ids.SERVER_ID_RE.test(serverId)) fail(400, 'serverId is invalid.');
    if (!PLATFORMS.has(platform)) fail(400, 'platform must be "ios" or "android".');
    if (!ENVIRONMENTS.has(environment)) fail(400, 'environment must be "sandbox" or "production".');
    if (typeof token !== 'string' || !TOKEN_RE[platform].test(token)) fail(400, 'token is invalid.');
    if (!(await store.getServer(serverId))) fail(404, 'Unknown server.');
    const handle = await store.upsertSubscription({ handle: ids.newHandle(), serverId, platform, environment, token });
    sendJson(res, 200, { handle });
  }

  // ── DELETE /v1/subscriptions/:handle ────────────────────────────────────────
  // No auth: the handle is the authority, and deleting only stops pushes.
  async function unsubscribe(req, res, handle) {
    limit(limiters.subscriptions, clientIp.of(req));
    if (!ids.HANDLE_RE.test(handle)) fail(400, 'handle is invalid.');
    await store.deleteSubscription(handle);
    sendJson(res, 200, { ok: true });
  }

  // ── POST /v1/push ───────────────────────────────────────────────────────────
  async function authenticate(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
    if (!m || !ids.SERVER_SECRET_RE.test(m[1])) fail(401, 'Missing or malformed server secret.');
    const hash = ids.sha256(m[1]);
    const server = await store.getServerBySecretHash(hash);
    if (!server || !ids.safeEqualHex(server.secretHash, hash)) fail(401, 'Unknown server secret.');
    return server;
  }

  async function push(req, res) {
    let serverId = '-';
    let platform = '-';
    let status = 'error';
    try {
      const server = await authenticate(req);
      serverId = server.id;
      limit(limiters.push, server.id);
      const body = await readJson(req, res);

      if (typeof body.handle !== 'string' || !ids.HANDLE_RE.test(body.handle)) fail(400, 'handle is invalid.');
      // Optional: a device with no key (Android) is sent the generic text alone.
      const envelope = body.envelope == null ? null : parseEnvelope(body.envelope);
      if (body.envelope != null && !envelope) fail(400, 'envelope is invalid.');
      const badge = body.badge;
      if (badge !== undefined && badge !== null && !(Number.isSafeInteger(badge) && badge >= 0)) {
        fail(400, 'badge must be a whole number from 0.');
      }
      const collapseId = body.collapseId;
      if (collapseId !== undefined && collapseId !== null && !(typeof collapseId === 'string' && collapseId.length > 0 && Buffer.byteLength(collapseId) <= 64)) {
        fail(400, 'collapseId must be 1 to 64 bytes.');
      }

      // A handle from another server is answered exactly like an unknown one,
      // so a server cannot learn which handles exist elsewhere.
      const sub = await store.getSubscription(body.handle);
      if (!sub || sub.serverId !== server.id) {
        status = 'gone';
        return sendJson(res, 404, { gone: true });
      }
      platform = sub.platform;

      const result = await deliver(server, sub, envelope, { badge, collapseId });
      if (result.gone) {
        await store.deleteSubscription(sub.handle);
        status = 'gone';
        return sendJson(res, 404, { gone: true });
      }
      if (result.ok) {
        status = 'sent';
        return sendJson(res, 200, { ok: true });
      }
      status = `refused:${result.status}${result.reason ? `:${result.reason}` : ''}`;
      return sendJson(res, 502, { error: `${PLATFORM_NAME[sub.platform]} refused the push (${result.status}${result.reason ? ` ${result.reason}` : ''}).` });
    } catch (err) {
      if (err instanceof HttpError) status = err.status === 429 ? 'rate_limited' : err.status === 503 ? 'unconfigured' : `rejected:${err.status}`;
      throw err;
    } finally {
      log(`push server=${serverId} platform=${platform} status=${status}`);
    }
  }

  async function deliver(server, sub, envelope, { badge, collapseId }) {
    const client = sub.platform === 'ios' ? apns : fcm;
    if (!client) fail(503, `${sub.platform === 'ios' ? 'iOS' : 'Android'} push is not configured on this relay.`);
    let r;
    try {
      if (sub.platform === 'ios') {
        const aps = { alert: { ...GENERIC }, sound: 'default' };
        if (envelope) aps['mutable-content'] = 1;
        if (Number.isInteger(badge)) aps.badge = badge;
        r = await apns.send({
          deviceToken: sub.token,
          environment: sub.environment,
          payload: { aps, ad: envelope ? { s: server.id, x: envelope } : { s: server.id } },
          collapseId
        });
        return { ok: r.status === 200, gone: r.gone, status: r.status, reason: r.reason };
      }
      r = await fcm.send({
        deviceToken: sub.token,
        notification: { ...GENERIC },
        data: envelope ? { s: server.id, x: JSON.stringify(envelope) } : { s: server.id },
        collapseId
      });
      return { ok: r.status === 200, gone: r.gone, status: r.status, reason: r.errorCode };
    } catch (err) {
      // Transport failures carry no token, but the message is still kept out
      // of the response: it can name internal hosts.
      log(`deliver error platform=${sub.platform}: ${err.message}`);
      fail(502, `Could not reach ${PLATFORM_NAME[sub.platform]}.`);
    }
  }

  // ── router ──────────────────────────────────────────────────────────────────
  async function route(req, res) {
    const path = new URL(req.url, 'http://relay').pathname;
    if (path === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', apns: Boolean(apns), fcm: Boolean(fcm) });
    }
    if (path === '/v1/servers' && req.method === 'POST') return registerServer(req, res);
    if (path === '/v1/subscriptions' && req.method === 'POST') return subscribe(req, res);
    if (path === '/v1/push' && req.method === 'POST') return push(req, res);
    const m = path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m && req.method === 'DELETE') return unsubscribe(req, res, m[1]);
    fail(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendJson(res, err.status, err.body);
      // Only the message: a database error's detail can quote the values involved.
      log(`error ${req.method} ${req.url.split('?')[0]}: ${err.message}`);
      sendJson(res, 500, { error: 'Internal error.' });
    });
  });
  server.headersTimeout = 10 * 1000;
  server.requestTimeout = 15 * 1000;

  function listen(port, host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  async function close() {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (apns) apns.close();
    clientIp.close();
    for (const l of Object.values(limiters)) l.close();
  }

  return { server, listen, close };
}

module.exports = { createRelay, DEFAULT_LIMITS, BODY_LIMIT, GENERIC };
