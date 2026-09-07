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

test('an app that says nothing gets drafts and no anonymous', () => {
  const c = fb.configFor({});
  assert.strictEqual(c.aiMode, 'draft', 'a bad auto-reply reaches a real person');
  assert.strictEqual(c.anonymous, false);
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.widget, true);
});

test('nothing advertises a snapshot option, because nothing captures one', () => {
  // It was in app.json and in configFor and did absolutely nothing. An option
  // that silently has no effect is worse than an absent one.
  assert.strictEqual(fb.configFor({ feedbackConfig: { snapshot: true } }).snapshot, undefined);
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../../../packages/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.ok(!('snapshot' in manifest.properties.feedback.properties));
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

console.log('\nfeedback: the intake is the one route a stranger can reach');

test('only the app\'s own origins are allowed, and only verified ones', () => {
  const out = fb.originsFor({ subdomain: 'valise' }, [
    { hostname: 'trips.example.com', status: 'active' },
    { hostname: 'claimed.example.com', status: 'pending' }
  ], 'astrodock.ai');
  assert.deepStrictEqual(out, ['https://valise.astrodock.ai', 'https://trips.example.com']);
});

test('no base domain yields no origins rather than a broken one', () => {
  assert.deepStrictEqual(fb.originsFor({ subdomain: 'valise' }, [], ''), []);
});

const routeSrc = fs.readFileSync(new URL('../src/routes/feedback-public.js', import.meta.url), 'utf8');

test('CORS is never answered with a wildcard', () => {
  assert.ok(!/Access-Control-Allow-Origin['"],\s*['"]\*/.test(routeSrc),
    'a wildcard would let any page on the internet post feedback as this app');
  assert.match(routeSrc, /Access-Control-Allow-Origin', origin/);
});

test('an unverifiable identity token is treated as no identity', () => {
  const fn = /function verifyIdentity\([\s\S]*?\n\}/.exec(routeSrc);
  assert.ok(fn, 'could not find verifyIdentity');
  assert.match(fn[0], /catch \{\s*\n\s*return null;/, 'a bad signature must return null, not throw or pass');
});

test('reading someone\'s own feedback requires a verified identity', () => {
  const route = /router\.get\('\/:slug\/mine'[\s\S]*?\n\}\);/.exec(routeSrc);
  assert.ok(route, 'could not find the /mine route');
  assert.match(route[0], /if \(!identity\) return res\.status\(401\)/);
  assert.match(route[0], /visibility: 'user'/, 'it must read the user thread, never the internal one');
});

test('the submit route returns the key and nothing else', () => {
  const route = /router\.post\('\/:slug'[\s\S]*?\n\}\);/.exec(routeSrc);
  assert.ok(route, 'could not find the submit route');
  assert.match(route[0], /res\.status\(201\)\.json\(\{ key: row\.key, status: row\.status \}\)/);
});

const widget = require('../src/lib/feedback-widget.js').widgetSource();

test('the widget isolates itself from the page it is dropped into', () => {
  assert.match(widget, /attachShadow/, 'without a shadow root it inherits the host page CSS');
  assert.match(widget, /data-app/);
});

test('the widget still works when the config call fails', () => {
  // Not knowing the category list is not a reason to stop someone reporting a bug.
  assert.match(widget, /catch\(function \(\) \{\}\)/);
});

console.log('\nfeedback: sending to a user is its own permission');

const scopes = require('../src/lib/scopes.js');
const adminSrc = fs.readFileSync(new URL('../src/routes/admin-feedback.js', import.meta.url), 'utf8');

test('feedback:reply is sensitive and separate from feedback:write', () => {
  assert.strictEqual(scopes.SCOPES['feedback:reply'].group, 'sensitive');
  assert.strictEqual(scopes.SCOPES['feedback:write'].group, 'apps');
});

test('the triage preset can draft but cannot send', () => {
  // This preset IS "the AI drafts by default". Not a runtime mode flag, but what
  // the key it holds actually permits.
  const t = scopes.PRESETS.triage.scopes;
  assert.ok(t.includes('feedback:write'), 'triage must be able to write notes and drafts');
  assert.ok(!t.includes('feedback:reply'), 'triage must not be able to reach a user');
  assert.ok(!t.includes('exec'));
});

test('a human operator can send', () => {
  assert.ok(scopes.PRESETS.operator.scopes.includes('feedback:reply'));
});

test('read-only picks up the new read scopes and none of the write ones', () => {
  const r = scopes.PRESETS.readonly.scopes;
  assert.ok(r.includes('feedback:read') && r.includes('work:read'));
  assert.ok(!r.includes('feedback:reply') && !r.includes('feedback:write'));
});

test('posting a reply without feedback:reply produces a draft rather than a refusal', () => {
  const route = /router\.post\('\/:slug\/:key\/reply'[\s\S]*?\n\}\);/.exec(adminSrc);
  assert.ok(route, 'could not find the reply route');
  assert.match(route[0], /requirePermission\('feedback:write'\)/);
  assert.match(route[0], /callerHasScope\(req\.auth, 'feedback:reply'\)/);
  assert.match(route[0], /pending = !maySend/);
});

test('sending a held draft needs the permission its author lacked', () => {
  const route = /router\.post\('\/:slug\/:key\/messages\/:id\/send'[\s\S]*?\n\}\);/.exec(adminSrc);
  assert.ok(route, 'could not find the send route');
  assert.match(route[0], /requirePermission\('feedback:reply'\)/);
});

test('the internal thread is served only behind feedback:read', () => {
  assert.match(adminSrc, /router\.use\(requireScope\('feedback:read'\)\)/);
  // and the app-facing router never mentions the internal thread at all
  assert.ok(!/'internal'/.test(routeSrc), 'the public route must not reference the internal thread');
});

console.log('\nfeedback: triage by model');

const ai = require('../src/lib/feedback-ai.js');
const aiSrc = fs.readFileSync(new URL('../src/lib/feedback-ai.js', import.meta.url), 'utf8');

test('the model does not choose who reads its output', () => {
  // It returns a `note` field and a `reply` field. This file routes one through
  // note() and the other through reply(). A model that ignores every instruction
  // and puts a stack trace in `reply` produces a bad reply, not a leaked note.
  assert.match(aiSrc, /fb\.note\(\{ feedbackId: item\.id, \.\.\.author, body: out\.note \}\)/);
  assert.match(aiSrc, /body: out\.reply/);
  assert.ok(!/visibility/.test(aiSrc), 'triage must never name a visibility');
});

test('a fenced JSON reply is still parsed', () => {
  const out = ai.parse('```json\n{"note":"double offset","reply":"Fixed.","kind":"problem","status":"shipped"}\n```');
  assert.strictEqual(out.note, 'double offset');
  assert.strictEqual(out.reply, 'Fixed.');
  assert.strictEqual(out.status, 'shipped');
});

test('a status the model invented is dropped rather than written', () => {
  const out = ai.parse('{"note":"n","reply":"r","status":"vibes"}');
  assert.strictEqual(out.status, null);
});

test('unparseable output is null, not a half-written item', () => {
  assert.strictEqual(ai.parse('I think the problem is...'), null);
  assert.strictEqual(ai.parse(''), null);
  assert.strictEqual(ai.parse('{"note":"","reply":""}'), null);
});

test('model output is truncated to the same limits as anything else', () => {
  const out = ai.parse(JSON.stringify({ note: 'x'.repeat(50000), reply: 'y' }));
  assert.strictEqual(out.note.length, fb.LIMITS.body);
});

test('the prompt tells the model the report is data, not instructions', () => {
  // The input is text a stranger typed into a form, so this is an input it will
  // genuinely receive.
  assert.match(ai.SYSTEM, /data, not instruction/i);
});

console.log('\nfeedback: the developer\'s own hook');

const hooks = require('../src/lib/feedback-hooks.js');

// These return promises. Run through the sync `test` above they would pass
// whatever they did, because nothing would ever look at the rejection.
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

await atest('a plaintext webhook is refused', async () => {
  const sent = await hooks.fireWebhook({ key: 'F-1' }, { feedbackConfig: { webhook: 'http://example.com/hook' } });
  assert.strictEqual(sent, false, 'http would put a user report on the wire in the clear');
});

await atest('a malformed webhook is refused rather than throwing', async () => {
  assert.strictEqual(await hooks.fireWebhook({ key: 'F-1' }, { feedbackConfig: { webhook: 'not a url' } }), false);
});

await atest('no webhook configured is not an error', async () => {
  assert.strictEqual(await hooks.fireWebhook({ key: 'F-1' }, {}), false);
});

test('the webhook cannot be pointed inside the perimeter', () => {
  // The URL comes from an app's own app.json, and the control plane sits in the
  // compose network where postgres, objectstore and runner answer to their
  // service names. Without this the platform makes that request for you.
  for (const bad of [
    'https://objectstore:8333/x', 'https://postgres/x', 'https://runner/x',
    'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x',
    'https://192.168.0.9/x', 'https://172.16.0.4/x',
    'https://169.254.169.254/latest/meta-data/', 'https://metadata.google.internal/x',
    'http://example.com/x'
  ]) {
    assert.strictEqual(hooks.isPublicHttps(bad), false, `${bad} should be refused`);
  }
  for (const good of ['https://example.com/hook', 'https://hooks.slack.com/services/x']) {
    assert.strictEqual(hooks.isPublicHttps(good), true, `${good} should be allowed`);
  }
});

test('a draft never closes the item', () => {
  // Letting the model pick `answered` or `shipped` in draft mode would stamp
  // answeredAt and drop the item out of the open list while its reply is still
  // unsent, which is how this feature would quietly lose a bug report.
  const src = fs.readFileSync(new URL('../src/lib/feedback-ai.js', import.meta.url), 'utf8');
  assert.match(src, /config\.aiMode === 'auto' \|\| !fb\.TERMINAL\.includes\(suggested\)/);
});

test('the webhook never carries an internal note', () => {
  const src = fs.readFileSync(new URL('../src/lib/feedback-hooks.js', import.meta.url), 'utf8');
  const payload = /body: JSON\.stringify\(\{[\s\S]*?\}\)/.exec(src);
  assert.ok(payload, 'could not find the webhook payload');
  assert.ok(!/note|internal|messages/.test(payload[0]), 'the payload must be the report only');
});

console.log('\nfeedback: what an app declares in app.json');

test('the manifest block reaches the column that configFor reads', () => {
  const applySrc = fs.readFileSync(new URL('../src/lib/apply.js', import.meta.url), 'utf8');
  assert.match(applySrc, /feedbackConfig: m\.feedback \|\| \{\}/);
});

test('an app that declares nothing gets the current platform opinion', () => {
  // Stored raw rather than defaulted at write time, so an app is not frozen to
  // whatever the defaults were the day it was first applied.
  const c = fb.configFor({ feedbackConfig: {} });
  assert.strictEqual(c.aiMode, 'draft');
  assert.deepStrictEqual(c.categories, fb.DEFAULT_CATEGORIES);
});

test('an app can turn the widget off and keep the API', () => {
  const c = fb.configFor({ feedbackConfig: { widget: false } });
  assert.strictEqual(c.widget, false);
  assert.strictEqual(c.enabled, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
