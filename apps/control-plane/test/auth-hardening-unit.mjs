// Pure-logic checks for the sign-in hardening. No database. Run: node test/auth-hardening-unit.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { verifyPassword, hashPassword } = require('../src/lib/passwords.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
const src = (p) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

console.log('passwords');

await test('a missing hash is a non-match, not a rejection', async () => {
  // bcryptjs rejects on a null hash, and an unhandled rejection exits the process.
  assert.strictEqual(await verifyPassword('anything', null), false);
  assert.strictEqual(await verifyPassword('anything', ''), false);
  assert.strictEqual(await verifyPassword(undefined, '$2a$12$abc'), false);
});

await test('a real hash still verifies', async () => {
  const h = await hashPassword('correct horse');
  assert.strictEqual(await verifyPassword('correct horse', h), true);
  assert.strictEqual(await verifyPassword('wrong', h), false);
});

console.log('\nsign-in paths');

await test('the MFA policy is checked in issue(), not only on the password path', () => {
  const s = src('routes/admin-auth.js');
  const issue = s.slice(s.indexOf('async function issue('), s.indexOf("router.post('/login'"));
  assert.match(issue, /security\.require_mfa/);
});

await test('/verify gives one answer for bad password, two-step accounts and no access', () => {
  const s = src('routes/verify.js');
  assert.ok(!/status\(403\)/.test(s), '/verify still answers 403 for no access');
  assert.match(s, /TOTP_REQUIRED/);
});

await test('codes are spent with a conditional UPDATE', () => {
  for (const f of ['lib/oauth.js', 'lib/auth-factors.js']) {
    const s = src(f);
    assert.match(s, /isNull\(schema\.(authorizationCodes|recoveryCodes)\.usedAt\)+\s*\.returning/, f);
  }
});

await test('the Pages login checks the second factor', () => {
  const s = src('routes/pages-public.js');
  assert.match(s, /factors\.checkTotp/);
  assert.ok(!/verifyPassword\(/.test(s), 'Pages login calls verifyPassword directly');
});

await test('/logout no longer redirects to any URL', () => {
  const s = src('routes/oauth.js');
  assert.ok(!/\^https\?:\\\/\\\/\/\.test\(String\(back\)\)\) return res\.redirect/.test(s));
  assert.match(s, /isPlatformOrigin/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
