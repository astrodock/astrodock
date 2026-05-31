'use strict';

const crypto = require('crypto');

// App secret used by /verify (shown to the app via TOOLSTEAD_APP_SECRET).
function generateAppSecret() {
  return 'sk_' + crypto.randomBytes(32).toString('hex');
}

// Generic high-entropy hex secret (app JWT signing key, internal DB password, ...).
function generateSecretHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Scoped API token (shown once at creation). Stored only as a SHA-256 hash.
function generateApiToken() {
  return 'tk_' + crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  generateAppSecret,
  generateSecretHex,
  generateWebhookSecret,
  generateApiToken,
  hashToken
};
