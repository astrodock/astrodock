'use strict';

// Compact JWS signing for the two provider tokens: ES256 for APNs and RS256
// for the Google service-account assertion. node:crypto covers both, so no
// JWT library is needed.

const crypto = require('node:crypto');

const b64url = (value) => Buffer.from(value).toString('base64url');

function sign(header, claims, key) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature;
  if (header.alg === 'ES256') {
    // JWS wants the raw r||s pair, not the DER encoding Node produces by default.
    signature = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  } else if (header.alg === 'RS256') {
    signature = crypto.sign('sha256', Buffer.from(input), key);
  } else {
    throw new Error(`Unsupported JWT algorithm ${header.alg}`);
  }
  return `${input}.${signature.toString('base64url')}`;
}

// Rebuilds a PEM block from text whose line breaks were lost or escaped.
// The Docker runtime writes env values to an env file with newlines turned
// into spaces, and dashboards often store "\n" literally; both break
// createPrivateKey. The base64 body tolerates any whitespace, so it is
// stripped and rewrapped.
function normalizePem(text) {
  const raw = String(text || '').replace(/\\n/g, '\n').trim();
  const m = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return raw;
  const body = m[2].replace(/\s+/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN ${m[1]}-----\n${body.join('\n')}\n-----END ${m[1]}-----\n`;
}

module.exports = { sign, normalizePem };
