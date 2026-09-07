// `astrodock feedback` / `astrodock work` against a stub client. Run: node test/feedback-unit.mjs
//
// What matters here is not the formatting. It is that `note` and `reply` hit
// different endpoints, and that a key which cannot send is told its message was
// held rather than being told it went.

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cmdFeedback, cmdWork, trunc } = require('../src/feedback.js');
const { parseFlags } = require('../src/cli.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

// A client that records what was asked of it and replies with what you queue.
function stub(reply) {
  const calls = [];
  return {
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return reply(method, path, body) || { status: 200, json: {} };
    }
  };
}

function capture() {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, done: () => { console.log = real; return lines.join('\n'); } };
}

console.log('feedback CLI');

await test('note and reply are different endpoints, not one with a flag', async () => {
  const c = stub(() => ({ status: 201, json: { message: { id: 'm1' }, sent: true } }));
  const out = capture();
  await cmdFeedback(c, ['note', 'valise', 'F-12', 'tz', 'applied', 'twice'], {});
  await cmdFeedback(c, ['reply', 'valise', 'F-12', 'Fixed,', 'reload'], {});
  out.done();
  assert.strictEqual(c.calls[0].path, '/admin/feedback/valise/F-12/notes');
  assert.strictEqual(c.calls[1].path, '/admin/feedback/valise/F-12/reply');
  assert.strictEqual(c.calls[0].body.body, 'tz applied twice');
});

await test('a held draft is reported as held, with the way to send it', async () => {
  // The failure this prevents is quiet: a key without feedback:reply writes what
  // it thinks is a reply, the command says "sent", and nobody ever sends it.
  const c = stub(() => ({ status: 201, json: { message: { id: 'm7' }, sent: false } }));
  const out = capture();
  await cmdFeedback(c, ['reply', 'valise', 'F-12', 'Fixed'], {});
  const text = out.done();
  assert.match(text, /Drafted/);
  assert.match(text, /Nobody has seen it/);
  assert.match(text, /feedback send valise F-12 m7/);
});

await test('an explicit --draft holds it even when the key could send', async () => {
  const c = stub(() => ({ status: 201, json: { message: { id: 'm8' }, sent: false } }));
  const out = capture();
  await cmdFeedback(c, ['reply', 'valise', 'F-12', 'Fixed'], { draft: true });
  out.done();
  assert.strictEqual(c.calls[0].body.draft, true);
});

await test('an error from the server is surfaced, not swallowed', async () => {
  const c = stub(() => ({ status: 403, json: { error: 'This action needs the "feedback:reply" permission.' } }));
  await assert.rejects(
    () => cmdFeedback(c, ['send', 'valise', 'F-12', 'm1'], {}),
    /feedback:reply/
  );
});

await test('a missing app is refused before any request goes out', async () => {
  const c = stub(() => ({ status: 200, json: {} }));
  await assert.rejects(() => cmdFeedback(c, ['list'], {}), /which app/);
  assert.strictEqual(c.calls.length, 0);
});

await test('--app is accepted instead of a positional', async () => {
  const c = stub(() => ({ status: 200, json: { feedback: [] } }));
  const out = capture();
  await cmdFeedback(c, ['list'], { app: 'valise' });
  out.done();
  assert.strictEqual(c.calls[0].path, '/admin/feedback/valise');
});

await test('a status filter reaches the query string', async () => {
  const c = stub(() => ({ status: 200, json: { feedback: [] } }));
  const out = capture();
  await cmdFeedback(c, ['list', 'valise'], { status: 'in_progress' });
  out.done();
  assert.strictEqual(c.calls[0].path, '/admin/feedback/valise?status=in_progress');
});

console.log('\nwork CLI');

await test('new sends the defaults the platform expects', async () => {
  const c = stub(() => ({ status: 201, json: { item: { key: 'I-1', title: 'x' } } }));
  const out = capture();
  await cmdWork(c, ['new', 'valise', 'Time', 'entry', 'cannot', 'be', 'edited'], { priority: 'P1' });
  out.done();
  assert.strictEqual(c.calls[0].body.title, 'Time entry cannot be edited');
  assert.strictEqual(c.calls[0].body.type, 'bug');
  assert.strictEqual(c.calls[0].body.priority, 'P1');
});

await test('relate defaults to relates_to', async () => {
  const c = stub(() => ({ status: 200, json: { ok: true } }));
  const out = capture();
  await cmdWork(c, ['relate', 'valise', 'I-45', 'I-12'], {});
  out.done();
  assert.strictEqual(c.calls[0].body.kind, 'relates_to');
});

await test('an unknown subcommand says what the options are', async () => {
  await assert.rejects(() => cmdWork(stub(() => ({}))
    , ['frobnicate', 'valise'], {}), /list\|show\|new\|status\|relate/);
});

console.log('\nhelpers');

await test('trunc collapses whitespace and marks what it cut', () => {
  assert.strictEqual(trunc('a  b\n c', 40), 'a b c');
  assert.strictEqual(trunc('abcdefghij', 5), 'abcd…');
});

console.log('\nflag parsing');

await test('a valueless flag does not eat the next word', () => {
  // --draft is the safety flag. Letting it swallow the message meant the natural
  // `reply F-12 --draft "Fixed"` failed with a usage error instead of drafting.
  const { flags, positional } = parseFlags(['reply', 'valise', 'F-12', '--draft', 'Fixed']);
  assert.strictEqual(flags.draft, true);
  assert.deepStrictEqual(positional, ['reply', 'valise', 'F-12', 'Fixed']);
});

await test('the same bug was reachable on existing flags', () => {
  // `astrodock deploy --local myapp` used to set local="myapp" and deploy the
  // wrong thing.
  const { flags, positional } = parseFlags(['deploy', '--local', 'myapp']);
  assert.strictEqual(flags.local, true);
  assert.deepStrictEqual(positional, ['deploy', 'myapp']);
});

await test('a flag that does take a value still takes it', () => {
  const { flags, positional } = parseFlags(['list', 'valise', '--status', 'in_progress']);
  assert.strictEqual(flags.status, 'in_progress');
  assert.deepStrictEqual(positional, ['list', 'valise']);
});

await test('--draft in its natural position reaches the request', async () => {
  const c = stub(() => ({ status: 201, json: { message: { id: 'm9' }, sent: false } }));
  const { flags, positional } = parseFlags(['reply', 'valise', 'F-12', '--draft', 'Fixed it']);
  const out = capture();
  await cmdFeedback(c, positional, flags);
  out.done();
  assert.strictEqual(c.calls[0].body.draft, true);
  assert.strictEqual(c.calls[0].body.body, 'Fixed it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
