'use strict';

// FCM HTTP v1 with a service account.
//
// The service account signs a JWT assertion (RS256) that Google's token
// endpoint exchanges for an hour-long access token. The token is reused until
// shortly before it expires, and concurrent pushes share one exchange.

const jwt = require('./jwt');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

function createFcm({ key, clientEmail, tokenUrl, sendUrl }) {
  let cached = null;
  let pending = null;

  async function exchange() {
    const iat = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { alg: 'RS256', typ: 'JWT' },
      { iss: clientEmail, scope: SCOPE, aud: tokenUrl, iat, exp: iat + 3600 },
      key
    );
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`FCM token exchange failed (${res.status}${data.error ? ` ${data.error}` : ''})`);
    }
    const ttlMs = (Number(data.expires_in) || 3600) * 1000;
    return { value: data.access_token, expiresAt: Date.now() + ttlMs - REFRESH_MARGIN_MS };
  }

  async function accessToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    if (!pending) {
      pending = exchange().then((t) => { cached = t; return t; }).finally(() => { pending = null; });
    }
    return (await pending).value;
  }

  // Resolves { status, errorCode, gone }. Rejects on transport or token failure.
  async function send({ deviceToken, notification, data, collapseId }) {
    const message = { token: deviceToken, notification, data };
    if (collapseId) message.android = { collapse_key: collapseId };
    const res = await fetch(sendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) cached = null;
    const errorCode = errorCodeOf(body);
    return { status: res.status, errorCode, gone: res.status === 404 || errorCode === 'UNREGISTERED' };
  }

  // FCM puts its own code in an FcmError detail; the top-level status is the
  // generic Google one.
  function errorCodeOf(body) {
    const err = body && body.error;
    if (!err) return null;
    const detail = (err.details || []).find((d) => d && d.errorCode);
    return (detail && detail.errorCode) || err.status || null;
  }

  return { send, close() {} };
}

module.exports = { createFcm, SCOPE };
