// The invite page has to actually run in a browser.
//
// Same hazard as the sign-in page, and the same reason for testing it this way:
// its JavaScript is written inside a template literal, which has its own escape
// rules, so a backslash that looks like a regex escape in the source is not one
// by the time a browser sees it. That class of bug is invisible in the source
// and fatal in the page — a SyntaxError kills the whole inline <script>, and the
// form renders perfectly and does nothing.
//
// It is also the first page a new user ever sees, so what it says is asserted
// too: whose invite, which address, and nothing about the box it runs on.
//
// Run: node test/invite-page.test.mjs

import assert from 'node:assert';
import vm from 'node:vm';
import { createRequire } from 'node:module';

process.env.ASTRODOCK_BASE_DOMAIN ||= 'example.com';
const require = createRequire(import.meta.url);
const { _internal } = require('../src/routes/invites.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('invite page');

const base = {
  appName: 'Valise', appId: 'valise', token: 'tok_abc',
  brandColor: '#0b7c56', logoUrl: '', invitedByName: 'Paul',
  email: 'ann@example.com', googleEnabled: true, needsCredential: true
};
const html = _internal.invitePage(base);

const scripts = (doc) => [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

await test('the page carries an inline script', () => {
  assert.ok(scripts(html).length >= 1, 'no <script> found');
});

await test('every inline script parses as JavaScript', () => {
  for (const src of scripts(html)) new vm.Script(src);
});

await test('the token reaches the browser as data, not HTML entities', () => {
  const src = scripts(html)[0];
  // esc() would have produced &quot; here, which is a syntax error in a script
  // block because browsers do not decode entities inside one.
  assert.ok(!/&quot;|&amp;/.test(src.split('\n')[0]), 'the config line was HTML-escaped');
  assert.match(src, /const CFG = \{"token":"tok_abc"\}/);
});

await test('a token containing </script> cannot break out of the block', () => {
  const nasty = _internal.invitePage({ ...base, token: 'a</script><script>alert(1)//' });
  // One script element, and the payload is neutralized inside it.
  assert.equal(scripts(nasty).length, 1, 'the payload opened a second script element');
  for (const src of scripts(nasty)) new vm.Script(src);
});

await test('it says who invited them and which address is being set up', () => {
  assert.match(html, /Paul invited you to Valise\./);
  assert.match(html, /ann@example\.com/);
});

await test('it never tells an end user about the platform account', () => {
  // The sign-in page used to read "Use your astrodock.ai account", which is the
  // one sentence that makes an invited user think they are in the wrong place.
  assert.ok(!/Use your .* account/.test(html), 'the page explains a platform account');
  assert.ok(!/astrodock\.ai/i.test(html), 'the page names the platform domain');
});

await test('no invite is offered without the app name on it', () => {
  assert.match(html, /<title>Join Valise<\/title>/);
  assert.match(html, /<h1>Join Valise<\/h1>/);
});

await test('an account that can already sign in is not asked for a password', () => {
  const settled = _internal.invitePage({ ...base, needsCredential: false });
  assert.ok(!/type="password"/.test(settled), 'it asked an existing account to set a password');
  assert.match(settled, /nothing to set up/);
  // And the script still has to parse, since the form it hooks is absent.
  for (const src of scripts(settled)) new vm.Script(src);
});

await test('with Google unconfigured the password form is the only way in', () => {
  const noGoogle = _internal.invitePage({ ...base, googleEnabled: false });
  assert.ok(!/Continue with Google/.test(noGoogle));
  assert.match(noGoogle, /type="password"/);
  // No "or set a password" divider when there is no "or".
  assert.ok(!/class="or"/.test(noGoogle));
});

await test('a brand colour is validated before it reaches the stylesheet', () => {
  // The value is interpolated into a <style> block, and "red;} body{..." is a
  // perfectly good string. `.err{display:none}` is in the shell either way, so
  // what is asserted is the declaration itself, not the absence of a keyword.
  const bad = _internal.invitePage({ ...base, brandColor: 'red;} body{visibility:hidden' });
  assert.ok(!/visibility:hidden/.test(bad), 'an app colour escaped into the stylesheet');
  for (const decl of bad.match(/--accent:[^;]*/g) || []) {
    assert.match(decl, /^--accent:#[0-9a-fA-F]{6}$/, `unvalidated accent: ${decl}`);
  }
});

await test('a logo URL is only used when it is https', () => {
  const sneaky = _internal.invitePage({ ...base, logoUrl: 'javascript:alert(1)' });
  assert.ok(!/javascript:/.test(sneaky), 'a non-https logo URL was rendered');
  const ok = _internal.invitePage({ ...base, logoUrl: 'https://cdn.example.com/l.png' });
  assert.match(ok, /referrerpolicy="no-referrer"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
