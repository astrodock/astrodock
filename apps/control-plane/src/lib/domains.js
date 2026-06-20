'use strict';

// Custom-domain helpers: hostname validation, the DNS records an operator must
// add, and TXT-based ownership verification. Ownership is proven by a TXT record
// (no need to know/trust the server IP); the A/AAAA record is what actually routes
// traffic and is implicitly validated when Caddy serves + issues a cert.

const dns = require('dns').promises;
const crypto = require('crypto');
const config = require('../config');

const CHALLENGE_PREFIX = '_astrodock-challenge';

function genToken() {
  return `astrodock-verify=${crypto.randomBytes(16).toString('hex')}`;
}

function normalizeHostname(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

// A valid public FQDN: ≥2 labels, each 1–63 chars of [a-z0-9-], no leading/trailing hyphen.
function validHostname(h) {
  if (!h || h.length > 253) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

// The records to display to the operator.
function dnsRecords(domain) {
  return [
    { type: 'A', name: domain.hostname, value: config.publicIp || '<your server IP>', purpose: 'point the domain at this server' },
    { type: 'TXT', name: `${CHALLENGE_PREFIX}.${domain.hostname}`, value: domain.verificationToken, purpose: 'prove you own the domain' }
  ];
}

// Resolve the challenge TXT and check the token is present.
async function verifyOwnership(domain) {
  try {
    const records = await dns.resolveTxt(`${CHALLENGE_PREFIX}.${domain.hostname}`);
    return records.map((chunks) => chunks.join('')).includes(domain.verificationToken);
  } catch {
    return false;
  }
}

module.exports = { genToken, normalizeHostname, validHostname, dnsRecords, verifyOwnership, CHALLENGE_PREFIX };
