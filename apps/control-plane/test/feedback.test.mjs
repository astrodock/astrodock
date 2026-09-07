// Feedback: the parts that decide what a user is allowed to read.
//
// The database half is exercised in CI against real Postgres. What is here is
// the half where a mistake is silent: a filter that lets an internal note
// through, a redaction that grows a field nobody meant to expose, a context blob
// that takes whatever a browser sends. None of that fails loudly. It just means
// a user reads something about their bug that was never written for them.
//
// Run: node test/feedback.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fb = require('../src/lib/feedback.js');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};

console.log('feedback: what reaches the person who reported it');

test('an internal note is never in the user-visible set', () => {
  const out = fb.userVisibleOf([
    { visibility: 'internal', body: 'tz offset applied twice in formatDuration()' },
    { visibility: 'user', body: 'Fixed. Reload and the time will stick.' }
  ]);
  assert.strictEqual(out.length, 1);
  assert.match(out[0].body, /Reload/);
});

test('an unapproved AI draft is not visible either', () => {
  // Written into the user thread, but no human has sent it. Filtering on
  // visibility alone would publish every draft the agent ever wrote.
  const out = fb.userVisibleOf([
    { visibility: 'user', body: 'draft reply', pending: true },
    { visibility: 'user', body: 'sent reply', pending: false }
  ]);
  assert.deepStrictEqual(out.map((m) => m.body), ['sent reply']);
});

test('redactForUser exposes a whitelist, not the row', () => {
  const item = {
    key: 'F-12', title: 'Time entry', body: 'could not change it', category: 'bug',
    status: 'shipped', createdAt: 'T0', answeredAt: 'T1',
    // Things that exist on the row and must not come out:
    snapshotKey: 'orgs/x/snap.html', context: { userAgent: 'Chrome' },
    submitterEmail: 'someone@example.com', appId: 'app-uuid', id: 'row-uuid'
  };
  const out = fb.redactForUser(item, [
    { visibility: 'internal', body: 'root cause: double offset', authorKind: 'operator' },
    { visibility: 'user', body: 'Fixed.', authorKind: 'operator', createdAt: 'T1' }
  ]);
  const serialized = JSON.stringify(out);
  for (const leak of ['snapshotKey', 'submitterEmail', 'appId', 'root cause', 'Chrome']) {
    assert.ok(!serialized.includes(leak), `redactForUser leaked ${leak}`);
  }
  assert.deepStrictEqual(out.messages.map((m) => m.body), ['Fixed.']);
  assert.strictEqual(out.messages[0].fromSupport, true);
});

test('a message from the user themselves is not marked as support', () => {
  const out = fb.redactForUser({ key: 'F-1' }, [
    { visibility: 'user', body: 'still broken', authorKind: 'user' }
  ]);
  assert.strictEqual(out.messages[0].fromSupport, false);
});

console.log('\nfeedback: submissions arrive from a browser');

test('context keeps known keys and drops everything else', () => {
  const out = fb.sanitizeContext({
    url: 'https://app.example.com/tasks', viewport: '1707x780',
    cookie: 'session=abc', localStorage: { token: 'x' }, __proto__: { polluted: true }
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['url', 'viewport']);
  assert.ok(!('cookie' in out), 'a cookie is not context');
});

test('a context value cannot be unbounded', () => {
  const out = fb.sanitizeContext({ url: 'x'.repeat(50000) });
  assert.strictEqual(out.url.length, fb.LIMITS.contextValue);
});

test('context survives being handed nonsense', () => {
  assert.deepStrictEqual(fb.sanitizeContext(null), {});
  assert.deepStrictEqual(fb.sanitizeContext('a string'), {});
});

test('an empty submission is refused, a bodied one is not', () => {
  assert.strictEqual(fb.validateSubmission({ title: '  ', body: '' }).ok, false);
  assert.strictEqual(fb.validateSubmission({ body: 'the button does nothing' }).ok, true);
});

test('a missing title is derived rather than left blank', () => {
  const { value } = fb.validateSubmission({ body: 'Cannot edit a time entry\nmore detail here' });
  assert.strictEqual(value.title, 'Cannot edit a time entry');
});

test('an unknown category becomes other rather than refusing the report', () => {
  const { value } = fb.validateSubmission({ body: 'x', category: 'whatever' });
  assert.strictEqual(value.category, 'other');
});

test('a configured category list is honored', () => {
  const config = fb.configFor({ feedbackConfig: { categories: ['billing'] } });
  assert.strictEqual(fb.validateSubmission({ body: 'x', category: 'billing' }, config).value.category, 'billing');
  assert.strictEqual(fb.validateSubmission({ body: 'x', category: 'bug' }, config).value.category, 'other');
});

console.log('\nfeedback: the platform\'s opinion is the default');

test('an app that says nothing gets drafts, no anonymous, no snapshot', () => {
  const c = fb.configFor({});
  assert.strictEqual(c.aiMode, 'draft', 'a bad auto-reply reaches a real person');
  assert.strictEqual(c.anonymous, false);
  assert.strictEqual(c.snapshot, false, 'a DOM snapshot captures whatever was on screen');
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.widget, true);
});

test('an unknown ai_mode falls back to draft rather than through', () => {
  assert.strictEqual(fb.configFor({ feedbackConfig: { ai_mode: 'yolo' } }).aiMode, 'draft');
  assert.strictEqual(fb.configFor({ feedbackConfig: { ai_mode: 'auto' } }).aiMode, 'auto');
});

console.log('\nfeedback: the invariant is structural, not remembered');

const src = fs.readFileSync(new URL('../src/lib/feedback.js', import.meta.url), 'utf8');

test('no exported function takes a visibility argument', () => {
  // The whole design rests on there being nothing to pass. If a caller can hand
  // in a visibility, then sooner or later one hands in the wrong one.
  for (const name of ['note', 'reply', 'submit', 'userVisible', 'messages']) {
    assert.strictEqual(typeof fb[name], 'function', `${name} should be exported`);
  }
  const signature = /async function (note|reply)\s*\(([^)]*)\)/g;
  let m;
  while ((m = signature.exec(src))) {
    assert.ok(!/visibility/.test(m[2]), `${m[1]}() must not accept a visibility argument`);
  }
});

test('addMessage, the only writer of visibility, is not exported', () => {
  assert.strictEqual(fb.addMessage, undefined,
    'exporting it would put a variable back in the visibility position');
  assert.match(src, /async function addMessage\(/, 'expected the private writer to exist');
});

test('note and reply each pass a literal', () => {
  assert.match(src, /addMessage\(feedbackId, 'internal'/, "note() must hard-code 'internal'");
  assert.match(src, /addMessage\(feedbackId, 'user'/, "reply() must hard-code 'user'");
});

test('the user-facing read path filters on pending as well as visibility', () => {
  const fn = /function userVisibleOf\([^)]*\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, 'could not find userVisibleOf');
  assert.match(fn[1], /visibility === 'user'/);
  assert.match(fn[1], /!m\.pending/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
