'use strict';

// APNs over HTTP/2 with token auth.
//
// Apple asks providers to keep connections open and reuse them, and treats a
// new connection per push as abuse. So there is one session per host, kept
// until it closes or errors, then opened again on the next push. The provider
// JWT is reused too: Apple rejects tokens refreshed more often than every 20
// minutes and expires them after 60.

const http2 = require('node:http2');
const jwt = require('./jwt');

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
};
const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

// Device tokens that will never work again. The subscription is deleted and
// the caller told the handle is gone.
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered']);

function createApns({ key, keyId, teamId, topic, host }) {
  const sessions = new Map();
  let cached = null;

  // RELAY_APNS_HOST points both environments at one origin. Tests only.
  function originFor(environment) {
    return host || (environment === 'sandbox' ? HOSTS.sandbox : HOSTS.production);
  }

  function token() {
    const now = Date.now();
    if (cached && now - cached.at < JWT_TTL_MS) return cached.value;
    const value = jwt.sign({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) }, key);
    cached = { value, at: now };
    return value;
  }

  function session(origin) {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    const drop = () => { if (sessions.get(origin) === s) sessions.delete(origin); };
    s.on('close', drop);
    s.on('goaway', drop);
    // Errors also reach the in-flight request; this listener only keeps an
    // idle session's error from crashing the process.
    s.on('error', drop);
    // An idle session must not hold the process open at shutdown.
    s.unref();
    sessions.set(origin, s);
    return s;
  }

  // Resolves { status, reason, gone }. Rejects only on transport failure.
  function send({ deviceToken, environment, payload, collapseId }) {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${token()}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json'
    };
    if (collapseId) headers['apns-collapse-id'] = collapseId;
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      let req;
      try {
        req = session(originFor(environment)).request(headers);
      } catch (err) {
        reject(err);
        return;
      }
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let text = '';
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      req.setEncoding('utf8');
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        if (settled || !status) return;
        settled = true;
        let reason = null;
        try { reason = text ? JSON.parse(text).reason || null : null; } catch { /* not JSON */ }
        // A rejected provider token is regenerated on the next push instead of
        // being reused for the rest of its 50 minutes.
        if (status === 403) cached = null;
        resolve({ status, reason, gone: status === 410 || GONE_REASONS.has(reason) });
      });
      req.on('error', fail);
      req.on('close', () => fail(new Error('APNs stream closed without a complete response')));
      req.end(body);
    });
  }

  function close() {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  }

  return { send, close, originFor, token };
}

module.exports = { createApns, HOSTS, JWT_TTL_MS };
