'use strict';

// Identifiers and secrets. Every value is a prefix plus random bytes in
// base64url, the same shape as the control plane's device tokens.

const crypto = require('node:crypto');

function randomId(prefix, bytes) {
  return prefix + crypto.randomBytes(bytes).toString('base64url');
}

const newServerId = () => randomId('srv_', 16);
const newServerSecret = () => randomId('rss_', 32);
const newHandle = () => randomId('sub_', 16);

// base64url of n bytes, without padding, is ceil(n * 4 / 3) characters.
const SERVER_ID_RE = /^srv_[A-Za-z0-9_-]{22}$/;
const SERVER_SECRET_RE = /^rss_[A-Za-z0-9_-]{43}$/;
const HANDLE_RE = /^sub_[A-Za-z0-9_-]{22}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Hashing both sides first makes the buffers the same length, which
// timingSafeEqual requires, and hides the length of the expected value.
function safeEqual(a, b) {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(x, y);
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = {
  newServerId, newServerSecret, newHandle,
  SERVER_ID_RE, SERVER_SECRET_RE, HANDLE_RE,
  sha256, safeEqual, safeEqualHex
};
