// Pure-logic unit tests: env computation + Caddyfile generation.
// Run: node test/unit.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { computeEnv, computeMissingRequired } = require('../src/lib/env-compute.js');
const { generateCaddyfile } = require('../src/provision/caddy.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const internalApp = {
  slug: 'notes', name: 'Notes', subdomain: 'notes', port: 3101,
  runtimeType: 'node', authMode: 'platform', databaseMode: 'internal', storageMode: 'internal',
  appSecret: 'sk_abc', appJwtSecret: 'jwt_abc',
  dbName: 'app_notes', dbUser: 'app_notes', dbPassword: 'pw', storagePrefix: 'notes/'
};

console.log('env computation');

test('internal app injects DB url, storage set, auth set, PORT alias', () => {
  const env = computeEnv(internalApp, []);
  assert.ok(env.ASTRODOCK_DATABASE_URL.includes('app_notes'));
  assert.strictEqual(env.ASTRODOCK_DATABASE_ENGINE, 'postgres');
  assert.strictEqual(env.ASTRODOCK_STORAGE_PREFIX, 'notes/');
  assert.ok(env.ASTRODOCK_STORAGE_ACCESS_KEY !== undefined);
  assert.strictEqual(env.ASTRODOCK_APP_ID, 'notes');
  assert.strictEqual(env.ASTRODOCK_APP_SECRET, 'sk_abc');
  assert.strictEqual(env.PORT, env.ASTRODOCK_PORT);
  assert.strictEqual(env.ASTRODOCK_PORT, '3101');
});

test('public/none app injects no db/storage/auth vars', () => {
  const env = computeEnv({ ...internalApp, authMode: 'public', databaseMode: 'none', storageMode: 'none' }, []);
  assert.ok(!('ASTRODOCK_DATABASE_URL' in env));
  assert.ok(!('ASTRODOCK_STORAGE_ENDPOINT' in env));
  assert.ok(!('ASTRODOCK_APP_SECRET' in env));
  assert.strictEqual(env.ASTRODOCK_APP_SLUG, 'notes');
});

test('declared var uses default when unset; value when set', () => {
  const withDefault = computeEnv({ ...internalApp, databaseMode: 'none', storageMode: 'none' },
    [{ key: 'INVOICE_PREFIX', kind: 'declared', value: null, defaultValue: 'INV-', isSecret: false }]);
  assert.strictEqual(withDefault.INVOICE_PREFIX, 'INV-');
  const withValue = computeEnv({ ...internalApp, databaseMode: 'none', storageMode: 'none' },
    [{ key: 'INVOICE_PREFIX', kind: 'declared', value: 'X-', defaultValue: 'INV-', isSecret: false }]);
  assert.strictEqual(withValue.INVOICE_PREFIX, 'X-');
});

test('gate: external storage requires the 5 storage vars', () => {
  const app = { ...internalApp, databaseMode: 'none', storageMode: 'external' };
  const missing = computeMissingRequired(app, []).map((m) => m.key);
  assert.ok(missing.includes('ASTRODOCK_STORAGE_ACCESS_KEY'));
  assert.ok(missing.includes('ASTRODOCK_STORAGE_SECRET_KEY'));
  assert.strictEqual(missing.length, 5);
});

console.log('\ncaddyfile generation');

test('node app block proxies /api/* and serves static', () => {
  const cfg = generateCaddyfile([internalApp]);
  assert.ok(cfg.includes('admin 0.0.0.0:2019'), 'keeps admin API up');
  assert.ok(cfg.includes('handle /api/*'), 'node app has /api proxy');
  assert.ok(/reverse_proxy runner:3101/.test(cfg), 'proxies /api to the runner container + app port');
  assert.ok(cfg.includes('try_files {path} /index.html'), 'SPA fallback');
});

test('docker app block whole-proxies the subdomain', () => {
  const cfg = generateCaddyfile([{ ...internalApp, slug: 'pytool', subdomain: 'pytool', runtimeType: 'docker', port: 3102 }]);
  assert.ok(/reverse_proxy app-pytool:3102/.test(cfg), 'whole-proxy to sibling container');
  assert.ok(!/handle \/api\/\*[\s\S]*app-pytool/.test(cfg), 'docker app has no /api split');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
