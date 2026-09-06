// Google sign-in: the parts that can be checked without Google or a database.
//
// The token verification itself needs Google's keys and is exercised by using
// it. What is tested here is the machinery around it, where the mistakes are
// quiet ones: a state that can be replayed, a nonce that is not checked, a
// domain allowlist that trusts something the browser sent.
//
// Run: node test/google.test.mjs

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push([name, fn]);

// google.js reads settings lazily, so it loads without a database as long as
// nothing asks it for configuration.
const google = require('../src/lib/google.js');

const CONFIG = { clientId: 'test-client', clientSecret: 'test-secret', allowedDomains: [] };

test('a state is consumed by its first use, whether or not that use succeeds', async () => {
  const { state } = await google.begin({ redirectUri: 'https://example.test/cb', context: { a: 1 }, config: CONFIG });
  assert.ok(state && state.length > 20, 'state is long and random');

  // Omitting the code fails AFTER the state is consumed, which is the point:
  // a failed attempt must not leave a replayable state behind.
  let first = null;
  await google.complete({ state, config: CONFIG }).catch((e) => { first = e.message; });
  assert.match(first || '', /did not return an authorization code/);

  let second = null;
  await google.complete({ code: 'x', state, config: CONFIG }).catch((e) => { second = e.message; });
  assert.match(second || '', /expired or was already used/);
});

test('an unknown state is refused before anything else happens', async () => {
  let err = null;
  await google.complete({ code: 'x', state: 'never-issued' }).catch((e) => { err = e.message; });
  assert.match(err || '', /expired or was already used/);
});

test('a missing state is refused', async () => {
  let err = null;
  await google.complete({ code: 'x' }).catch((e) => { err = e.message; });
  assert.match(err || '', /expired or was already used/);
});

test('both issuer spellings Google uses are accepted', () => {
  assert.ok(google.ISSUERS.includes('https://accounts.google.com'));
  assert.ok(google.ISSUERS.includes('accounts.google.com'));
});

test('the authorization URL carries state, nonce and a forced account chooser', async () => {
  {
    const { url, state } = await google.begin({ redirectUri: 'https://example.test/cb', config: { ...CONFIG, clientId: 'abc123' } });
    const u = new URL(url);
    assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.strictEqual(u.searchParams.get('client_id'), 'abc123');
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('state'), state);
    assert.ok(u.searchParams.get('nonce'), 'a nonce is sent, or the ID token binds to nothing');
    assert.notStrictEqual(u.searchParams.get('nonce'), state, 'nonce and state are separate values');
    assert.strictEqual(u.searchParams.get('prompt'), 'select_account');
    assert.match(u.searchParams.get('scope'), /openid/);
  }
});

test('two sign-ins never share a state or a nonce', async () => {
  const a = await google.begin({ redirectUri: 'https://example.test/cb', config: CONFIG });
  const b = await google.begin({ redirectUri: 'https://example.test/cb', config: CONFIG });
  assert.notStrictEqual(a.state, b.state);
  assert.notStrictEqual(new URL(a.url).searchParams.get('nonce'), new URL(b.url).searchParams.get('nonce'));
});

// The masking that makes `secret: true` mean something. Settings loads config
// but not the database for these two.
test('a secret setting is never handed back, and the mask never overwrites it', async () => {
  const settings = require('../src/lib/settings.js');
  assert.strictEqual(settings.SECRET_MASK, '••••••');
  assert.ok(settings.REGISTRY['google.client_secret'].secret, 'the client secret is marked secret');
  assert.ok(!settings.REGISTRY['google.client_id'].secret, 'the client id is not a secret');
  // setSetting returns undefined without writing when handed the mask back.
  const out = await settings.setSetting('google.client_secret', '••••••', 'test');
  assert.strictEqual(out, undefined, 'saving the mask is a no-op, not an overwrite');
});

(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`  FAIL  ${name}\n        ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} passed, ${checks.length - passed} failed`);
})();
