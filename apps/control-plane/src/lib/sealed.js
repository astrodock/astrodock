'use strict';

// Handing a key to the CLI so that only the CLI can read it.
//
// The CLI makes an X25519 key pair for each astrodock login and sends the
// public half with its PKCE challenge. When it collects the key, the key comes
// back sealed to that public half: an ephemeral X25519 exchange, HKDF-SHA256,
// AES-256-GCM. Whoever relays the sign-in (the hosted service) or learns its
// device code and verifier still holds only ciphertext.
//
// The check code is how a person knows the request they approve is the one
// their terminal started. It is derived from the challenge and the public key,
// which the CLI computes itself, so a relay that swapped either would put a
// different code on the approval page. The CLI's copy (packages/cli/src/login.js)
// must stay byte-for-byte the same.

const crypto = require('crypto');

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

function validPublicKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k) && Buffer.from(k, 'base64url').length === 32;
}

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw, 'base64url')]), format: 'der', type: 'spki' });
}

function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('base64url');
}

function derive(shared, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(String(salt)), Buffer.from('astrodock-cli-login'), 32));
}

/** Seal `plain` to the CLI's public key. `salt` is the PKCE challenge. */
function seal(plain, clientPublicKey, salt) {
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(clientPublicKey) });
  const key = derive(shared, salt);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { alg: 'x25519-hkdf-sha256-aes256gcm', epk: rawPublicKey(eph.publicKey), iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

/** The other side, for tests (the CLI has its own copy). */
function open(sealed, privateKey, salt) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKeyObject(sealed.epk) });
  const d = crypto.createDecipheriv('aes-256-gcm', derive(shared, salt), Buffer.from(sealed.iv, 'base64url'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64url')), d.final()]).toString('utf8');
}

/** Twelve letters, shown as XXXX-XXXX-XXXX. */
function checkCode(challenge, clientPublicKey) {
  const h = crypto.createHash('sha256').update(`astrodock-check:${challenge}:${clientPublicKey || ''}`).digest();
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

module.exports = { seal, open, checkCode, validPublicKey, rawPublicKey, publicKeyObject };
