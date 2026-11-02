'use strict';

// Notifications to phones: the inbox row, the encryption, and the relay.
// See MOBILE_DESIGN.md, sections 6 and 7.
//
// Apple accepts a push for the app only when it is signed with the publisher's
// APNs key, which a self-hosted server does not have. So every server sends
// through the publisher's relay, and the relay must not be able to read what it
// carries. Each notification is encrypted to the device's own X25519 key:
//
//   ephemeral X25519 key pair; shared secret with the device's public key
//   key   = HKDF-SHA256(shared, salt = ephemeral public key, info = "astrodock-push-v1"), 32 bytes
//   AES-256-GCM, 12-byte random nonce, no additional data
//   envelope { v: 1, e: b64(ephemeral public), n: b64(nonce), c: b64(ciphertext || tag) }
//
// The phone's Notification Service Extension does the same in CryptoKit. One
// fixed test vector (test/fixtures/push-vector.json) is the reference for both.
//
// Runs in both processes: the api (POST /notify) and the runner (operator
// alerts routed from health and deploy events).

const crypto = require('crypto');
const { and, eq, gt, isNull, isNotNull, inArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const settings = require('./settings');
const netGuard = require('./net-guard');

const INFO = 'astrodock-push-v1';
const VERSION = 1;
const TITLE_MAX = 120;
const BODY_MAX = 1000;

// DER wrappers that turn a raw 32-byte X25519 key into one Node will import.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const publicKeyFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
const privateKeyFromRaw = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
const rawPublic = (key) => key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
const rawPrivate = (key) => key.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);

function deriveKey(shared, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(INFO, 'utf8'), 32));
}

/**
 * Encrypt a plaintext (string or Buffer) to a device's public key.
 *
 * `ephemeralPrivateKey` and `nonce` are for the test vector only. In use both
 * are fresh for every message, and reusing a nonce under one key would break
 * GCM entirely.
 */
function encrypt(plaintext, devicePublicKeyB64, { ephemeralPrivateKey = null, nonce = null } = {}) {
  const devicePub = Buffer.from(String(devicePublicKeyB64), 'base64');
  if (devicePub.length !== 32) throw new Error('device public key must be 32 bytes');
  const eph = ephemeralPrivateKey
    ? privateKeyFromRaw(Buffer.from(ephemeralPrivateKey))
    : crypto.generateKeyPairSync('x25519').privateKey;
  const ephPub = rawPublic(crypto.createPublicKey(eph));
  const shared = crypto.diffieHellman({ privateKey: eph, publicKey: publicKeyFromRaw(devicePub) });
  const key = deriveKey(shared, ephPub);
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (n.length !== 12) throw new Error('nonce must be 12 bytes');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, n);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return { v: VERSION, e: ephPub.toString('base64'), n: n.toString('base64'), c: ct.toString('base64') };
}

/** The phone's half, in Node. Used by the tests; the phone does this in Swift. */
function decrypt(envelope, devicePrivateKeyRaw) {
  if (!envelope || envelope.v !== VERSION) throw new Error('unknown envelope version');
  const ephPub = Buffer.from(envelope.e, 'base64');
  const n = Buffer.from(envelope.n, 'base64');
  const c = Buffer.from(envelope.c, 'base64');
  const shared = crypto.diffieHellman({
    privateKey: privateKeyFromRaw(Buffer.from(devicePrivateKeyRaw)),
    publicKey: publicKeyFromRaw(ephPub)
  });
  const key = deriveKey(shared, ephPub);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, n);
  decipher.setAuthTag(c.subarray(c.length - 16));
  return Buffer.concat([decipher.update(c.subarray(0, c.length - 16)), decipher.final()]).toString('utf8');
}

// APNs and FCM cap a payload at 4 KB, and the envelope is base64 of the
// ciphertext, a third larger again. 2048 bytes of plaintext keeps the envelope
// near 2.8 KB, which leaves room for the rest of the payload. A 1000-character
// body in a script that takes three or four bytes a character would not fit.
const PLAINTEXT_MAX_BYTES = 2048;
const ELLIPSIS = '\u2026';

// Cut to `n` code points, so a character is never split between its bytes.
const cut = (chars, n) => (n >= chars.length ? chars.join('') : chars.slice(0, n).join('') + ELLIPSIS);

/**
 * What the phone decrypts. Short keys for the same 4 KB reason. The body is
 * shortened (then the title, if that is still not enough) to fit; the inbox row
 * keeps the full text, and the app reads it from there.
 */
function plaintextFor(notification, app, { maxBytes = PLAINTEXT_MAX_BYTES } = {}) {
  const fields = {
    id: notification.id,
    t: String(notification.title || ''),
    b: String(notification.body || ''),
    a: app ? app.slug : null,
    an: app ? app.name : null,
    p: notification.path || null
  };
  const size = (f) => Buffer.byteLength(JSON.stringify(f), 'utf8');
  if (size(fields) <= maxBytes) return JSON.stringify(fields);

  // The longest prefix that fits, by binary search over code points.
  const fit = (key) => {
    const chars = Array.from(fields[key]);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size({ ...fields, [key]: cut(chars, mid) }) <= maxBytes) lo = mid; else hi = mid - 1;
    }
    if (lo > 0) fields[key] = cut(chars, lo);
    else fields[key] = chars.length && size({ ...fields, [key]: ELLIPSIS }) <= maxBytes ? ELLIPSIS : '';
  };
  // The title first, with the body reduced to its ellipsis, so the title never
  // takes the room the body's ellipsis needs. Then the body gets what is left.
  const body = fields.b;
  fields.b = body ? ELLIPSIS : '';
  if (size(fields) > maxBytes) fit('t');
  fields.b = body;
  fit('b');
  return JSON.stringify(fields);
}

// ── the relay ────────────────────────────────────────────────────────────────

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/** The registered relay, or null until Register has been pressed. */
async function relay() {
  const url = trimUrl(await settings.getSetting('push.relay_url', ''));
  const serverId = String(await settings.getSetting('push.server_id', '') || '');
  const secret = String(await settings.getSecretSetting('push.server_secret', '') || '');
  if (!url || !serverId || !secret) return null;
  return { url, serverId, secret };
}

/** For discovery and the admin page. Never includes the secret. */
async function status() {
  const r = await relay();
  return {
    relayUrl: trimUrl(await settings.getSetting('push.relay_url', '')),
    registered: !!r,
    serverId: r ? r.serverId : null
  };
}

/**
 * Register this server with a relay and keep what it hands back.
 *
 * The registration code is sent and forgotten: it is the relay operator's gate
 * on who may register, not something this server needs again.
 */
async function register({ relayUrl, registrationCode, actor }) {
  const url = trimUrl(relayUrl || await settings.getSetting('push.relay_url', ''));
  const checked = netGuard.checkUrl(url);
  if (!checked.ok) throw Object.assign(new Error(`The relay address ${checked.reason}.`), { status: 400 });

  const res = await netGuard.requestJson('POST', `${url}/v1/servers`, {
    name: config.baseDomain || 'Astrodock',
    url: config.authBaseUrl(),
    ...(registrationCode ? { registrationCode: String(registrationCode) } : {})
  }, { timeoutMs: 10000 });
  if (!res.ok) {
    throw Object.assign(new Error(`The relay refused: ${res.reason || 'no answer'}.`), { status: 502 });
  }
  const { serverId, serverSecret } = res.body || {};
  if (!/^srv_[A-Za-z0-9_-]+$/.test(String(serverId || '')) || !/^rss_[A-Za-z0-9_-]+$/.test(String(serverSecret || ''))) {
    throw Object.assign(new Error('The relay answered, but not with a server id and secret.'), { status: 502 });
  }
  await settings.setSetting('push.relay_url', url, actor);
  await settings.setSetting('push.server_id', serverId, actor);
  await settings.setSetting('push.server_secret', serverSecret, actor);
  return { relayUrl: url, serverId };
}

// ── sending ──────────────────────────────────────────────────────────────────

/**
 * Push one inbox row to every device of its user that has push set up.
 *
 * Never throws: a push is a courtesy on top of the inbox, which already holds
 * the notification. A relay that says a handle is gone has dropped that
 * subscription, so the device's push fields are cleared and it is not tried
 * again until the app registers afresh.
 */
async function pushNotification(notification, app = null) {
  const out = { sent: 0, gone: 0, failed: 0 };
  try {
    const mobile = require('./mobile');
    if (!await mobile.enabled()) return out;
    const r = await relay();
    if (!r) return out;

    const devices = await db.select().from(schema.mobileDevices).where(and(
      eq(schema.mobileDevices.userId, notification.userId),
      isNotNull(schema.mobileDevices.pushHandle),
      isNull(schema.mobileDevices.revokedAt),
      gt(schema.mobileDevices.expiresAt, new Date())
    ));
    if (!devices.length) return out;

    const badge = await mobile.unreadCount(notification.userId);
    const plaintext = plaintextFor(notification, app);
    await Promise.all(devices.map(async (d) => {
      // A device with no key (Android) gets the relay's generic text alone.
      let envelope = null;
      if (d.pushPublicKey) {
        try { envelope = encrypt(plaintext, d.pushPublicKey); }
        catch { out.failed++; return; }
      }
      const res = await netGuard.requestJson('POST', `${r.url}/v1/push`,
        { handle: d.pushHandle, ...(envelope ? { envelope } : {}), badge },
        { headers: { Authorization: `Bearer ${r.secret}` }, timeoutMs: 8000 });
      if (res.ok) { out.sent++; return; }
      if (res.status === 404 && res.body && res.body.gone) {
        out.gone++;
        // Only if the handle is still the one that was sent to: the app may have
        // registered a new one in the meantime.
        await db.update(schema.mobileDevices)
          .set({ pushHandle: null, pushPublicKey: null, pushEnvironment: null })
          .where(and(eq(schema.mobileDevices.id, d.id), eq(schema.mobileDevices.pushHandle, d.pushHandle)))
          .catch(() => {});
        return;
      }
      out.failed++;
    }));
  } catch (err) {
    console.error('[push] send failed:', err.message);
  }
  return out;
}

/** Write an inbox row. Title and body are cut to their limits, not refused. */
async function store({ userId, app = null, title, body = '', path = null }) {
  const [row] = await db.insert(schema.userNotifications).values({
    userId,
    appId: app ? app.id : null,
    title: String(title || '').slice(0, TITLE_MAX),
    body: String(body || '').slice(0, BODY_MAX),
    path: path || null
  }).returning();
  return row;
}

/**
 * The `push` channel for operator alerts (lib/notifications). An inbox row with
 * no app and no path for each person the rule names, then a push to their
 * devices. `users` is "operators" or a list of user ids; inactive accounts are
 * skipped either way.
 */
async function alertUsers(users, { title, body }) {
  let rows;
  if (users === 'operators') {
    rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(isNotNull(schema.users.operatorRole), eq(schema.users.isActive, true)));
  } else {
    const ids = (Array.isArray(users) ? users : []).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id)));
    if (!ids.length) return 0;
    rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(inArray(schema.users.id, ids), eq(schema.users.isActive, true)));
  }
  for (const u of rows) {
    const n = await store({ userId: u.id, title, body });
    await pushNotification(n, null);
  }
  return rows.length;
}

module.exports = {
  INFO, VERSION, TITLE_MAX, BODY_MAX, PLAINTEXT_MAX_BYTES,
  encrypt, decrypt, plaintextFor, rawPublic, rawPrivate, publicKeyFromRaw, privateKeyFromRaw,
  relay, status, register, pushNotification, store, alertUsers
};
