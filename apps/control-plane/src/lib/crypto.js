'use strict';

// Envelope encryption for secrets at rest (AES-256-GCM). Stored blobs are
// "v1:<iv>:<tag>:<ciphertext>" (all base64). If no master key is configured,
// values pass through as plaintext (back-compat) — server.js warns at boot.
// decryptSecret() transparently returns legacy/plaintext values unchanged, so a
// store can hold a mix during migration to an encrypted setup.

const crypto = require('crypto');
const config = require('../config');

function masterKey() {
  if (!config.secretKey) return null;
  // derive a stable 32-byte key from whatever the operator provided
  return crypto.createHash('sha256').update(config.secretKey).digest();
}

function encryptSecret(plaintext) {
  if (plaintext == null) return plaintext;
  const key = masterKey();
  if (!key) return String(plaintext); // plaintext fallback
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(blob) {
  if (blob == null) return blob;
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) return blob; // legacy/plaintext
  const key = masterKey();
  if (!key) return blob; // no key — can't decrypt; surface the blob rather than crash
  try {
    const parts = blob.split(':');
    if (parts.length !== 4) return null;
    const [, ivb, tagb, ctb] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
    decipher.setAuthTag(Buffer.from(tagb, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctb, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // corrupt blob or wrong/rotated key — never leak a crypto error to the caller
    return null;
  }
}

function isEnabled() { return !!masterKey(); }

module.exports = { encryptSecret, decryptSecret, isEnabled };
