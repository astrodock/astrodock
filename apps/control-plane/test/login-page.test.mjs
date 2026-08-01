// The hosted login page has to actually run in a browser.
//
// Its JavaScript is written inside a template literal, which has its own escape
// rules — and `\+` in a template literal is not a regex escape, it is the
// character `+`. So `.replace(/\+/g, '-')` in the source reached the browser as
// `.replace(/+/g, '-')`: an invalid regex, a SyntaxError, and — because a
// SyntaxError kills the whole inline <script> — no submit handler and no passkey
// button. The page rendered perfectly and did nothing at all.
//
// Reading the source cannot catch that; the bug only exists after the template
// is evaluated. So this renders the real page and parses what comes out.

import assert from 'node:assert';
import vm from 'node:vm';
import { createRequire } from 'node:module';

process.env.ASTRODOCK_BASE_DOMAIN ||= 'example.com';
const require = createRequire(import.meta.url);
const { _internal } = require('../src/routes/oauth.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('hosted login page');

const html = _internal.loginPage({
  appName: 'Test App', appId: 'app_123',
  redirectUri: 'https://example.com/cb', state: 'st', nonce: 'nc'
});

function scripts(doc) {
  return [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('the page carries an inline script', () => {
  assert.ok(scripts(html).length >= 1, 'no <script> found in the rendered page');
});

test('every inline script parses as JavaScript', () => {
  // new vm.Script throws on a syntax error without running anything, which is
  // exactly the check a browser performs before binding a single handler.
  for (const [i, code] of scripts(html).entries()) {
    try { new vm.Script(code); }
    catch (e) { assert.fail(`inline script #${i + 1} does not parse: ${e.message}`); }
  }
});

test('the base64url helpers survived the template literal intact', () => {
  const code = scripts(html).join('\n');
  // The precise regressions: these must reach the browser as regexes escaping a
  // literal + and /, not as /+/ and // .
  assert.ok(code.includes(String.raw`.replace(/\+/g, '-')`),
    'the + replacement lost its backslash on the way through the template');
  assert.ok(code.includes(String.raw`.replace(/\//g, '_')`),
    'the / replacement lost its backslash on the way through the template');
  assert.ok(!/replace\(\/\+\/g/.test(code), 'emitted an unescaped /+/ — invalid regex');
});

test('the round trip actually works when run', () => {
  // Execute just the two helpers in a sandbox and check they agree.
  const code = scripts(html).join('\n');
  const start = code.indexOf('const b64uToBuf');
  const end = code.indexOf('document.getElementById', start);
  assert.ok(start > -1 && end > start, 'could not isolate the helpers');

  const ctx = vm.createContext({
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array, Math, String
  });
  vm.runInContext(code.slice(start, end) + '\nglobalThis.__t = { b64uToBuf, bufToB64u };', ctx);

  const bytes = new Uint8Array([251, 255, 190, 0, 17]);   // encodes with + and /
  const encoded = ctx.__t.bufToB64u(bytes.buffer);
  assert.ok(!/[+/=]/.test(encoded), `base64url must not contain + / or =, got "${encoded}"`);
  assert.deepStrictEqual([...ctx.__t.b64uToBuf(encoded)], [...bytes], 'round trip lost data');
});

test('the config reaches the browser as usable data, not HTML entities', () => {
  const code = scripts(html).join('\n');
  assert.doesNotMatch(code, /&quot;|&amp;|&lt;|&gt;/,
    'HTML entities inside a <script> are not decoded by the browser');

  // Evaluate the CFG line and check the values arrived intact.
  const line = /const CFG = .*/.exec(code);
  assert.ok(line, 'no CFG assignment found');
  const ctx = vm.createContext({});
  vm.runInContext(line[0] + '\nglobalThis.__c = CFG;', ctx);
  assert.strictEqual(ctx.__c.appId, 'app_123');
  assert.strictEqual(ctx.__c.redirectUri, 'https://example.com/cb');
  assert.strictEqual(ctx.__c.state, 'st');
});

test('a value containing </script> cannot break out of the block', () => {
  // The reason the embedding needs escaping at all. An app name or redirect is
  // attacker-influenced in the sense that it comes from a registered app record.
  const nasty = _internal.loginPage({
    appName: 'X', appId: 'a',
    redirectUri: 'https://e.com/cb?x=</script><script>globalThis.PWNED=1</script>',
    state: 's', nonce: 'n'
  });
  const blocks = scripts(nasty);
  for (const [i, code] of blocks.entries()) {
    try { new vm.Script(code); }
    catch (e) { assert.fail(`inline script #${i + 1} broke: ${e.message}`); }
  }
  assert.doesNotMatch(nasty, /<script>globalThis\.PWNED/,
    'a value ended the script element and started a new one');
});

test('no third-party script is pulled onto the login page', () => {
  // A CDN import here would put someone else inside the authentication path.
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'the login page loads an external script');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
