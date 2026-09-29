// The check that decides whether a deploy worked.
//
// It exists because a deploy could copy new code, watch the new process die on
// EADDRINUSE, get a cheerful 200 from a stale instance still holding the port,
// and report success. That happened six times in a row before anyone noticed the
// running code was weeks old.
//
// Then the check itself inverted. `appStatus(app.slug)` was passed a string where
// an app object was expected; appStatus reads `app.runtimeType` to choose between
// pm2 and docker, so the string fell through to the pm2 path and looked up a
// process named `undefined`. Not finding one, it returned the not-found default
// of `stopped` with 0 restarts, and every Node deploy ended in "app process is
// stopped after deploy" while the app ran perfectly. Eight in a row, across two
// apps, before anyone read the log closely.
//
// Both failures are invisible in isolation: the deploy log is the only witness
// and it reads plausibly either way. So the shape is asserted here instead.
//
// Run: node test/deploy-verify.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/runner/deploy-worker.js', import.meta.url), 'utf8');
const pc = fs.readFileSync(new URL('../src/runner/process-control.js', import.meta.url), 'utf8');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};

console.log('deploy verification');

test('appStatus is never handed a slug', () => {
  // The whole bug, in one assertion. appStatus(app) reads app.runtimeType.
  const calls = [...src.matchAll(/appStatus\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'expected deploy-worker to ask the supervisor something');
  for (const arg of calls) {
    assert.ok(!/\.slug\b/.test(arg),
      `appStatus(${arg}) passes a slug; it needs the app object to tell pm2 from docker`);
  }
});

test('appStatus really does depend on the app object', () => {
  // If this ever stops being true the assertion above is worthless, so it is
  // checked rather than assumed.
  assert.match(pc, /function appStatus\(app, procs\)/);
  assert.match(pc, /app\.runtimeType === 'docker'/);
});

test('a process not found reports stopped, which is why a slug was silent', () => {
  // The reason the mistake produced a plausible message instead of a crash.
  assert.match(pc, /if \(!p\) return \{ status: 'stopped'/);
});

test('the status is allowed to settle rather than read once', () => {
  assert.match(src, /async function settledStatus\(app\)/);
  assert.match(src, /await settledStatus\(app\)/);
  const fn = /async function settledStatus\(app\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'could not find settledStatus');
  assert.match(fn[0], /SETTLE_ATTEMPTS/, 'it must retry');
  assert.match(fn[0], /setTimeout/, 'it must wait between reads');
});

test('online has to hold twice, because a crash loop passes through online', () => {
  const fn = /async function settledStatus\(app\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(fn, /onlineRuns/);
  assert.match(fn, />= 2/, 'one online reading is a process on its way back down');
});

test('an app out of restarts is not waited on for the full window', () => {
  const fn = /async function settledStatus\(app\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(fn, /'errored'/);
  assert.match(fn, /restarts \|\| 0\) > 3/);
});

test('anything other than online fails the deploy', () => {
  // Previously only errored and stopped failed, so `launching` forever, or an
  // unknown status, would have been reported as a success.
  assert.match(src, /if \(state !== 'online'\)/);
});

test('the stale-instance line is only claimed when something answered', () => {
  // It used to append an empty log line when the probe had failed, which is how
  // a deploy log grows blank rows nobody can explain.
  assert.match(src, /if \(healthy\) \{\s*\n\s*await appendLog\('Something is still answering/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
