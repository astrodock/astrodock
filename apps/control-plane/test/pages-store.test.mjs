// Object-store paths for Pages, against a real S3 (SeaweedFS).
//
// movePrefix is the one that has to be right: it copies every object to a new
// prefix and then DELETES the originals. Getting the order wrong, or missing an
// object, silently empties a page. Verified against a real store rather than a
// mock, because the failure mode is in the S3 semantics, not in our arithmetic.
//
// Skipped unless ASTRODOCK_OBJECTSTORE_ENDPOINT points somewhere reachable.
// test/with-pages-store.sh brings a throwaway SeaweedFS up and down.

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const endpoint = process.env.ASTRODOCK_OBJECTSTORE_ENDPOINT;
if (!endpoint) {
  console.log('pages store: skipped — set ASTRODOCK_OBJECTSTORE_ENDPOINT to run');
  process.exit(0);
}
try {
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
  if (!res) throw new Error('no answer');
} catch (err) {
  console.log(`pages store: skipped — ${endpoint} is not reachable (${err.message})`);
  process.exit(0);
}

const store = require('../src/lib/pages-store.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

console.log('pages object store');

const A = 'testpageaaaa';
const B = 'testpagebbbb';
const FILES = [
  ['index.html', '<h1>hello</h1>', 'text/html; charset=utf-8'],
  ['styles/main.css', 'body{margin:0}', 'text/css; charset=utf-8'],
  ['img/deep/nested/logo.svg', '<svg/>', 'image/svg+xml']
];

try {
  await store.deleteAll(A);
  await store.deleteAll(B);

  await test('files round-trip, including nested paths', async () => {
    for (const [name, body, ct] of FILES) {
      await store.putFile(A, name, Buffer.from(body), ct);
    }
    for (const [name, body] of FILES) {
      const got = await store.getFile(A, name);
      assert.ok(got, `${name} missing`);
      assert.strictEqual(got.body.toString(), body);
    }
  });

  await test('a missing file is null, not a throw', async () => {
    assert.strictEqual(await store.getFile(A, 'nope.html'), null);
  });

  await test('moving to a new page id brings every file with it', async () => {
    const moved = await store.movePrefix(A, B);
    assert.strictEqual(moved, FILES.length, `moved ${moved} of ${FILES.length}`);
    for (const [name, body] of FILES) {
      const got = await store.getFile(B, name);
      assert.ok(got, `${name} did not arrive at the new id`);
      assert.strictEqual(got.body.toString(), body, `${name} arrived corrupted`);
    }
  });

  await test('and leaves nothing behind at the old one', async () => {
    for (const [name] of FILES) {
      assert.strictEqual(await store.getFile(A, name), null, `${name} still readable at the old id`);
    }
  });

  await test('deleteAll clears a whole page', async () => {
    await store.deleteAll(B);
    for (const [name] of FILES) {
      assert.strictEqual(await store.getFile(B, name), null, `${name} survived deleteAll`);
    }
  });

  await test('moving an empty page is a no-op, not an error', async () => {
    assert.strictEqual(await store.movePrefix('testpageempty', 'testpageempty2'), 0);
  });
} finally {
  await store.deleteAll(A).catch(() => {});
  await store.deleteAll(B).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
