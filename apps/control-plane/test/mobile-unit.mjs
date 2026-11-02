// The mobile app's pure logic: push encryption against the shared test vector,
// the PKCE S256 check, and the input checks. No database.
//
// The vector in test/fixtures/push-vector.json is the contract with the phone:
// the mobile app's Swift decryption is checked against the same file. If the
// encryption here changes, that file changes, and the phone stops decrypting.
//
// Run: node test/mobile-unit.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN ||= 'example.com';

const push = require('../src/lib/push.js');
const mobile = require('../src/lib/mobile.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const vector = JSON.parse(fs.readFileSync(new URL('./fixtures/push-vector.json', import.meta.url), 'utf8'));
const b64 = (s) => Buffer.from(s, 'base64');

console.log('push encryption');

test('the vector\'s public keys match its private keys', () => {
  for (const [priv, pub] of [['devicePrivateKey', 'devicePublicKey'], ['ephemeralPrivateKey', 'ephemeralPublicKey']]) {
    const key = crypto.createPublicKey(push.privateKeyFromRaw(b64(vector[priv])));
    assert.strictEqual(push.rawPublic(key).toString('base64'), vector[pub], pub);
  }
});

test('encrypting with the vector\'s fixed inputs gives exactly its envelope', () => {
  const env = push.encrypt(vector.plaintext, vector.devicePublicKey, {
    ephemeralPrivateKey: b64(vector.ephemeralPrivateKey),
    nonce: b64(vector.nonce)
  });
  assert.deepStrictEqual(env, vector.envelope);
});

test('the vector\'s intermediate values are what the scheme produces', () => {
  const ephPub = b64(vector.ephemeralPublicKey);
  const shared = crypto.diffieHellman({
    privateKey: push.privateKeyFromRaw(b64(vector.devicePrivateKey)),
    publicKey: push.publicKeyFromRaw(ephPub)
  });
  assert.strictEqual(shared.toString('base64'), vector.sharedSecret);
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, ephPub, Buffer.from(vector.info, 'utf8'), 32));
  assert.strictEqual(key.toString('base64'), vector.key);
  assert.strictEqual(vector.info, push.INFO);
  assert.strictEqual(Buffer.from(vector.plaintext, 'utf8').toString('base64'), vector.plaintextBase64);
});

test('the device decrypts the vector\'s envelope', () => {
  assert.strictEqual(push.decrypt(vector.envelope, b64(vector.devicePrivateKey)), vector.plaintext);
});

test('a fresh envelope round-trips, and each one uses a new key and nonce', () => {
  const pair = crypto.generateKeyPairSync('x25519');
  const pub = push.rawPublic(pair.publicKey).toString('base64');
  const a = push.encrypt('hello', pub);
  const b = push.encrypt('hello', pub);
  assert.notStrictEqual(a.e, b.e);
  assert.notStrictEqual(a.n, b.n);
  assert.strictEqual(push.decrypt(a, push.rawPrivate(pair.privateKey)), 'hello');
});

test('a tampered envelope is refused', () => {
  const c = b64(vector.envelope.c);
  c[0] ^= 1;
  assert.throws(() => push.decrypt({ ...vector.envelope, c: c.toString('base64') }, b64(vector.devicePrivateKey)));
});

test('the wrong device cannot decrypt', () => {
  const other = push.rawPrivate(crypto.generateKeyPairSync('x25519').privateKey);
  assert.throws(() => push.decrypt(vector.envelope, other));
});

test('a public key that is not 32 bytes is refused', () => {
  assert.throws(() => push.encrypt('x', Buffer.alloc(31).toString('base64')), /32 bytes/);
});

console.log('push payload size');

const longest = {
  id: '5f0c2a3e-8b1d-4c7a-9e2f-1a2b3c4d5e6f',
  title: '中'.repeat(push.TITLE_MAX),
  body: '\u{1F600}'.repeat(push.BODY_MAX),
  path: '/tasks/12'
};
const app = { slug: 'assistant', name: 'Assistant' };

test('a 1000-character multibyte body is cut so the envelope stays under 3 KB', () => {
  const text = push.plaintextFor(longest, app);
  assert.ok(Buffer.byteLength(text, 'utf8') <= push.PLAINTEXT_MAX_BYTES, `plaintext is ${Buffer.byteLength(text)} bytes`);
  const pub = push.rawPublic(crypto.generateKeyPairSync('x25519').publicKey).toString('base64');
  const size = JSON.stringify(push.encrypt(text, pub)).length;
  assert.ok(size < 3072, `envelope is ${size} bytes`);
});

test('the cut lands on a character boundary and ends with an ellipsis', () => {
  const p = JSON.parse(push.plaintextFor(longest, app));
  assert.ok(p.b.endsWith('…'));
  // Every code point before the ellipsis is a whole emoji: no lone surrogate,
  // which is what a cut between a character's bytes would leave.
  const chars = Array.from(p.b.slice(0, -1));
  assert.ok(chars.length > 0);
  assert.ok(chars.every((c) => c === '\u{1F600}'), 'a character was split');
  assert.strictEqual(p.t, longest.title, 'the title fit and should be untouched');
  assert.strictEqual(p.a, 'assistant');
  assert.strictEqual(p.p, '/tasks/12');
});

test('the title is cut too when the body alone cannot make room', () => {
  const p = JSON.parse(push.plaintextFor({ ...longest, title: '\u{1F600}'.repeat(2000) }, app));
  assert.ok(Buffer.byteLength(JSON.stringify(p), 'utf8') <= push.PLAINTEXT_MAX_BYTES);
  assert.ok(p.t.endsWith('…'));
});

test('a short notification is left alone', () => {
  const p = JSON.parse(push.plaintextFor({ id: 'x', title: 'Task Due', body: 'Call the bank', path: null }, null));
  assert.deepStrictEqual(p, { id: 'x', t: 'Task Due', b: 'Call the bank', a: null, an: null, p: null });
});

console.log('pkce');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

test('the RFC 7636 example verifier hashes to its challenge', () => {
  // RFC 7636, appendix B.
  assert.strictEqual(mobile.s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.ok(mobile.verifierMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
});

test('the right verifier matches, a wrong one does not', () => {
  assert.ok(mobile.verifierMatches(verifier, challenge));
  assert.ok(!mobile.verifierMatches(crypto.randomBytes(32).toString('base64url'), challenge));
});

test('a verifier sent as the challenge itself (plain method) does not match', () => {
  assert.ok(!mobile.verifierMatches(challenge, challenge));
});

test('malformed verifiers and challenges are refused', () => {
  assert.ok(!mobile.validVerifier('short'));
  assert.ok(!mobile.validVerifier('a'.repeat(129)));
  assert.ok(!mobile.validVerifier(`${'a'.repeat(43)} `));
  assert.ok(!mobile.validChallenge('abc'));
  assert.ok(!mobile.validChallenge(`${challenge}=`));
  assert.ok(!mobile.verifierMatches(undefined, challenge));
  assert.ok(mobile.validChallenge(challenge));
});

test('the redirect carries the code and echoes state', () => {
  const u = new URL(mobile.redirectFor('amc_abc', 'st 1'));
  assert.strictEqual(`${u.protocol}//${u.host}`, 'astrodock://auth');
  assert.strictEqual(u.searchParams.get('code'), 'amc_abc');
  assert.strictEqual(u.searchParams.get('state'), 'st 1');
});

console.log('input checks');

test('a path must start with a single slash', () => {
  for (const ok of ['/', '/tasks/12', '/a?b=c#d', '/café']) assert.ok(mobile.validPath(ok), ok);
  for (const bad of ['', 'tasks', '//evil.test', '/\\evil.test', 'https://evil.test/', '/a\nb', '/a\u0000', null, 42, `/${'a'.repeat(2000)}`]) {
    assert.ok(!mobile.validPath(bad), JSON.stringify(bad));
  }
});

test('a device public key must be 32 bytes, in either base64 alphabet', () => {
  const raw = crypto.randomBytes(32);
  assert.strictEqual(mobile.parsePublicKey(raw.toString('base64')), raw.toString('base64'));
  assert.strictEqual(mobile.parsePublicKey(raw.toString('base64url')), raw.toString('base64'));
  assert.strictEqual(mobile.parsePublicKey(crypto.randomBytes(31).toString('base64')), null);
  assert.strictEqual(mobile.parsePublicKey('not base64'), null);
});

test('push registration needs a handle and an environment, and a key when there is one', () => {
  const good = { handle: `sub_${crypto.randomBytes(16).toString('hex')}`, publicKey: crypto.randomBytes(32).toString('base64'), environment: 'sandbox' };
  assert.deepStrictEqual(mobile.cleanPush(good), good);
  assert.throws(() => mobile.cleanPush({ ...good, handle: 'tok_123' }), /handle/);
  assert.throws(() => mobile.cleanPush({ ...good, environment: 'staging' }), /environment/);
  assert.throws(() => mobile.cleanPush({ ...good, publicKey: 'abc' }), /publicKey/);
  // Android sends no key: it is pushed the generic text.
  assert.deepStrictEqual(mobile.cleanPush({ handle: good.handle, environment: 'production' }),
    { handle: good.handle, publicKey: null, environment: 'production' });
});

test('a device must say which platform it is', () => {
  assert.deepStrictEqual(mobile.cleanDevice({ name: ' Ann\'s iPhone ', platform: 'ios', appVersion: '1.0.0' }),
    { name: 'Ann\'s iPhone', platform: 'ios', appVersion: '1.0.0' });
  assert.throws(() => mobile.cleanDevice({ name: 'x', platform: 'web' }), /platform/);
  assert.throws(() => mobile.cleanDevice(null), /platform/);
});

console.log('mobile sign-in page');

test('the hosted sign-in page renders for the mobile app, and its script parses', () => {
  const { loginPage } = require('../src/routes/oauth.js')._internal;
  const html = loginPage({
    appName: 'Astrodock', appId: '', redirectUri: '', state: 'st', nonce: '', googleEnabled: true,
    mobile: { codeChallenge: challenge, state: 'st' }
  });
  assert.match(html, /Sign In to Astrodock/);
  assert.match(html, /\/login\/google\/start\?mobile=1&amp;code_challenge=/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const code of scripts) new vm.Script(code);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
