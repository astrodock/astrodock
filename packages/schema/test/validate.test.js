'use strict';

// Minimal zero-dep test runner (node test/validate.test.js)
const assert = require('node:assert');
const { validate, reservedCatalog, userRequiredReservedKeys } = require('..');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const valid = {
  schemaVersion: '1',
  slug: 'notes',
  name: 'Notes',
  subdomain: 'notes',
  source: { branch: 'main' },
  runtime: { type: 'node' },
  auth: { mode: 'platform' },
  database: { mode: 'internal' },
  storage: { mode: 'internal' }
};

console.log('app.json schema validation');

test('accepts a valid internal-everything manifest', () => {
  const r = validate(valid);
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('accepts the docker sample with declared env', () => {
  const r = validate({
    schemaVersion: '1', slug: 'py-tool', name: 'Python Tool', subdomain: 'pytool',
    source: { branch: 'main', repoPath: 'service' },
    runtime: { type: 'docker', dockerfile: 'Dockerfile' },
    auth: { mode: 'platform' }, database: { mode: 'internal' }, storage: { mode: 'none' },
    env: [{ key: 'WORKERS', secret: false, required: false, default: '2' }]
  });
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('rejects a reserved-prefixed env key', () => {
  const r = validate({ ...valid, env: [{ key: 'TOOLSTEAD_PORT' }] });
  assert.strictEqual(r.valid, false);
});

test('rejects a bad slug', () => {
  const r = validate({ ...valid, slug: 'Bad Slug' });
  assert.strictEqual(r.valid, false);
});

test('rejects unknown top-level property', () => {
  const r = validate({ ...valid, nope: true });
  assert.strictEqual(r.valid, false);
});

test('rejects bad runtime type', () => {
  const r = validate({ ...valid, runtime: { type: 'python' } });
  assert.strictEqual(r.valid, false);
});

test('rejects missing required field', () => {
  const { slug, ...noSlug } = valid;
  const r = validate(noSlug);
  assert.strictEqual(r.valid, false);
});

console.log('\nreserved env catalog');

test('internal everything: db url is auto, not user-required', () => {
  const cat = reservedCatalog({ auth: 'platform', database: 'internal', storage: 'internal' });
  const dbUrl = cat.find((v) => v.key === 'TOOLSTEAD_DATABASE_URL');
  assert.strictEqual(dbUrl.source, 'auto');
  assert.deepStrictEqual(userRequiredReservedKeys({ database: 'internal', storage: 'internal' }), []);
});

test('external db + external storage: the right vars are user-required', () => {
  const req = userRequiredReservedKeys({ database: 'external', storage: 'external' });
  assert.ok(req.includes('TOOLSTEAD_DATABASE_URL'));
  assert.ok(req.includes('TOOLSTEAD_STORAGE_ACCESS_KEY'));
  assert.ok(req.includes('TOOLSTEAD_STORAGE_SECRET_KEY'));
  assert.ok(req.includes('TOOLSTEAD_STORAGE_ENDPOINT'));
  assert.ok(req.includes('TOOLSTEAD_STORAGE_BUCKET'));
  assert.ok(req.includes('TOOLSTEAD_STORAGE_REGION'));
});

test('public + none: only the six always-on vars', () => {
  const cat = reservedCatalog({ auth: 'public', database: 'none', storage: 'none' });
  assert.strictEqual(cat.length, 6);
});

test('storage internal injects a prefix; external does not', () => {
  const internal = reservedCatalog({ storage: 'internal' }).map((v) => v.key);
  const external = reservedCatalog({ storage: 'external' }).map((v) => v.key);
  assert.ok(internal.includes('TOOLSTEAD_STORAGE_PREFIX'));
  assert.ok(!external.includes('TOOLSTEAD_STORAGE_PREFIX'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
