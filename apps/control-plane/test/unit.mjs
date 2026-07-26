// Pure-logic unit tests: env computation + Caddyfile generation.
// Run: node test/unit.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// A base domain is no longer defaulted — empty means "first-run setup pending", and
// the Caddy generator then emits the wizard site instead of hostname-keyed blocks.
// Set one before loading config so these tests exercise the CONFIGURED path; the
// unconfigured path gets its own tests at the bottom.
process.env.ASTRODOCK_BASE_DOMAIN = 'localhost';

const { computeEnv, computeMissingRequired } = require('../src/lib/env-compute.js');
const { generateCaddyfile } = require('../src/provision/caddy.js');
const config = require('../src/config.js');

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

console.log('\nfirst-run setup mode');

test('unconfigured: serves the wizard on :80 with auto_https off', () => {
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: '' });
    assert.strictEqual(config.isConfigured(), false);
    const cfg = generateCaddyfile([internalApp]);
    assert.ok(cfg.includes(':80 {'), 'listens on plain :80 (reachable by IP)');
    assert.ok(cfg.includes('auto_https off'), 'no cert attempt without a domain');
    assert.ok(cfg.includes('handle /setup/*'), 'setup API is reachable');
    assert.ok(cfg.includes('try_files {path} /index.html'), 'admin SPA is served');
    assert.ok(!cfg.includes('notes.'), 'no hostname-keyed app blocks before a domain exists');
  } finally {
    config.applyRuntimeDomain({ baseDomain: saved });
  }
});

test('unconfigured: pages host does not swallow every request', () => {
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: '' });
    assert.strictEqual(config.isPagesHost('pages.'), false);
    assert.strictEqual(config.isPagesHost('anything'), false);
  } finally {
    config.applyRuntimeDomain({ baseDomain: saved });
  }
});

test('configured admin host still routes /setup/* to the API', () => {
  // Regression: the admin block proxied /admin, /verify, /webhooks, /health and
  // /account but not /setup — so once a domain was set, GET /setup/status fell
  // through to the SPA catch-all and returned HTML. The admin UI calls it on every
  // mount, so it silently degraded instead of failing loudly. Caught end-to-end,
  // not by any unit test, which is why this one exists.
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: 'apps.example.com' });
    const cfg = generateCaddyfile([]);
    assert.ok(cfg.includes('handle /setup/*'), '/setup/* must be proxied on the admin host');
    const adminIdx = cfg.indexOf('admin.apps.example.com');
    const setupIdx = cfg.indexOf('handle /setup/*', adminIdx);
    const spaIdx = cfg.indexOf('try_files {path} /index.html', adminIdx);
    assert.ok(setupIdx > adminIdx && setupIdx < spaIdx, '/setup/* must come before the SPA catch-all');
  } finally {
    config.applyRuntimeDomain({ baseDomain: saved });
  }
});

test('setting a domain at runtime re-keys routing and the pages host', () => {
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: 'apps.example.com', tlsMode: 'auto', acmeEmail: 'ops@example.com' });
    assert.strictEqual(config.pages.host, 'pages.apps.example.com');
    assert.strictEqual(config.isPagesHost('pages.apps.example.com'), true);
    const cfg = generateCaddyfile([internalApp]);
    assert.ok(cfg.includes('admin.apps.example.com'), 'admin block picks up the new domain');
    assert.ok(cfg.includes('notes.apps.example.com'), 'app block picks up the new domain');
    assert.ok(cfg.includes('email ops@example.com'), 'ACME contact flows into the global block');
  } finally {
    config.applyRuntimeDomain({ baseDomain: saved, tlsMode: 'internal', acmeEmail: '' });
  }
});

test('CORS opens only while unconfigured, then closes to the base domain', () => {
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: '' });
    assert.strictEqual(config.isAllowedOrigin('http://203.0.113.10'), true, 'wizard reachable by IP');
    config.applyRuntimeDomain({ baseDomain: 'apps.example.com' });
    assert.strictEqual(config.isAllowedOrigin('http://203.0.113.10'), false, 'closes once configured');
    assert.strictEqual(config.isAllowedOrigin('https://admin.apps.example.com'), true);
  } finally {
    config.applyRuntimeDomain({ baseDomain: saved });
  }
});

console.log('\nport exposure');

const { parsePorts } = require('../src/runner/exposure.js');

test('0.0.0.0 and [::] bindings count as internet-facing; 127.0.0.1 does not', () => {
  const p = parsePorts('0.0.0.0:443->443/tcp, [::]:443->443/tcp, 127.0.0.1:5432->5432/tcp');
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(p.map((x) => x.public), [true, true, false]);
  assert.strictEqual(p[2].hostPort, '5432');
});

test('container-internal ports (no ->) are not published at all', () => {
  assert.deepStrictEqual(parsePorts('8333/tcp, 9333/tcp'), []);
  assert.strictEqual(parsePorts('').length, 0);
  assert.strictEqual(parsePorts(null).length, 0);
});

test('host port is read, not the container port', () => {
  const [p] = parsePorts('0.0.0.0:15432->5432/tcp');
  assert.strictEqual(p.hostPort, '15432');
  assert.strictEqual(p.containerPort, '5432');
  assert.strictEqual(p.proto, 'tcp');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
