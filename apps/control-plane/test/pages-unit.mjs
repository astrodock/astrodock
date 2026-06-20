// Pure-logic unit tests for the Pages helpers. Run: node test/pages-unit.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.ASTRODOCK_SECRET_KEY = process.env.ASTRODOCK_SECRET_KEY || 'pages-unit-test-key';

const P = require('../src/lib/pages.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('pages helpers');

test('page id is 12 chars of [a-z0-9]', () => {
  for (let i = 0; i < 50; i++) assert.match(P.generatePageId(), /^[a-z0-9]{12}$/);
  assert.notStrictEqual(P.generatePageId(), P.generatePageId());
});

test('valid file names: flat + nested ok', () => {
  ['index.html', 'style.css', 'img/logo.png', 'a/b/c.js', 'data.json', 'a-b_c.1.txt'].forEach((n) =>
    assert.ok(P.validFileName(n), n));
});
test('invalid file names: traversal / absolute / spaces / bad', () => {
  ['../x', '/etc/passwd', 'a/../b', 'my file.html', '.hidden', 'a\\b', '', 'a/', '/'].forEach((n) =>
    assert.ok(!P.validFileName(n), n));
});

test('content types + text detection', () => {
  assert.match(P.contentTypeFor('a.html'), /text\/html/);
  assert.strictEqual(P.contentTypeFor('a.png'), 'image/png');
  assert.strictEqual(P.contentTypeFor('a.bin'), 'application/octet-stream');
  assert.ok(P.isTextFile('x.md'));
  assert.ok(!P.isTextFile('x.png'));
});

test('passkey HMAC: valid only for the right page+key', () => {
  const tok = P.passkeyToken('abc123', 'sekret');
  assert.ok(P.passkeyValid('abc123', 'sekret', tok));
  assert.ok(!P.passkeyValid('abc123', 'wrong', tok));     // wrong key
  assert.ok(!P.passkeyValid('other1', 'sekret', tok));    // different page (can't unlock cross-page)
  assert.ok(!P.passkeyValid('abc123', 'sekret', 'forged'));
});

test('platform session round-trips; tampering rejected', () => {
  const t = P.signSession({ id: 'u1', email: 'a@b.com', name: 'A' });
  const s = P.verifySession(t);
  assert.strictEqual(s.sub, 'u1');
  assert.strictEqual(s.email, 'a@b.com');
  assert.strictEqual(P.verifySession(t + 'x'), null);
  assert.strictEqual(P.verifySession('nope'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
