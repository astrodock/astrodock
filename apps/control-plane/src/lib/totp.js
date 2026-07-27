'use strict';

// TOTP (RFC 6238) — implemented directly rather than pulled in, because it is
// about sixty lines of well-specified HMAC and a dependency here would be a
// dependency in the authentication path.
//
// SHA-1, 6 digits, 30-second step. Not a security preference: it is what every
// authenticator app interoperates with, and an algorithm nobody's phone supports
// protects nothing.

const crypto = require('crypto');

const DIGITS = 6;
const STEP_SECONDS = 30;
// One step either side. Phone clocks drift; rejecting a code that is 5 seconds
// stale generates support requests, not security.
const DRIFT_STEPS = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[=\s]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte secret, base32-encoded for authenticator apps. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function stepFor(when = Date.now()) {
  return Math.floor(when / 1000 / STEP_SECONDS);
}

function codeForStep(secretB32, step) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  // Dynamic truncation, RFC 4226 §5.4
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Check a submitted code.
 *
 * `lastStep` is the last step this user already spent. A code stays valid for its
 * whole window, so without remembering that, a code observed in transit — or read
 * over someone's shoulder — is replayable for up to 90 seconds. Returns the step
 * that matched so the caller can persist it.
 */
function verify(secretB32, submitted, { lastStep = null, when = Date.now() } = {}) {
  const code = String(submitted || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'format' };

  const now = stepFor(when);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue; // already spent
    const expected = codeForStep(secretB32, step);
    // Constant-time: a timing oracle on a six-digit code is worth having.
    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, step };
  }
  return { ok: false, reason: lastStep != null && stepFor(when) <= lastStep ? 'replay' : 'mismatch' };
}

/** The otpauth:// URI an authenticator app scans (or that a user pastes). */
function provisioningUri({ secret, account, issuer = 'Astrodock' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params}`;
}

module.exports = {
  generateSecret, verify, provisioningUri, codeForStep, stepFor,
  base32Encode, base32Decode, DIGITS, STEP_SECONDS, DRIFT_STEPS
};
