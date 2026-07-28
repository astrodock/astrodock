// Pure-logic unit tests: env computation + Caddyfile generation.
// Run: node test/unit.mjs
import assert from 'node:assert';
import fs from 'node:fs';
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

test('every control-plane path is proxied, in BOTH routing modes', () => {
  // This has now bitten twice: a route added to one Caddy block but not the other
  // returns index.html rather than JSON — a 200 that fails on parse, which is far
  // harder to notice than a 404. Assert the list rather than individual paths.
  const saved = config.baseDomain;
  try {
    config.applyRuntimeDomain({ baseDomain: '' });
    const setupMode = generateCaddyfile([]);
    ['/setup/*', '/admin/*', '/whoami', '/health'].forEach((p) =>
      assert.ok(setupMode.includes(`handle ${p}`), `setup mode must proxy ${p}`));

    config.applyRuntimeDomain({ baseDomain: 'apps.example.com' });
    const configured = generateCaddyfile([]);
    ['/setup/*', '/admin/*', '/whoami', '/authorize', '/token', '/login*', '/verify', '/health']
      .forEach((p) => assert.ok(configured.includes(`handle ${p}`), `configured mode must proxy ${p}`));
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

console.log('\npreset setup token');

const { validatePresetToken, MIN_PRESET_TOKEN_LENGTH } = require('../src/routes/setup.js');

test('a short operator-supplied token is refused, not silently accepted', () => {
  // It would be brute-forceable over the open internet in the window before the
  // account is claimed. Falling back to a generated token is the safe failure.
  assert.strictEqual(validatePresetToken('short').ok, false);
  assert.strictEqual(validatePresetToken('a'.repeat(MIN_PRESET_TOKEN_LENGTH - 1)).ok, false);
  assert.strictEqual(validatePresetToken('a'.repeat(MIN_PRESET_TOKEN_LENGTH)).ok, true);
});

test('empty / whitespace tokens are refused', () => {
  assert.strictEqual(validatePresetToken('').ok, false);
  assert.strictEqual(validatePresetToken(null).ok, false);
  assert.strictEqual(validatePresetToken(undefined).ok, false);
  // A pasted cloud-init value can pick up stray whitespace; that would silently
  // never match what the operator thinks they typed.
  assert.strictEqual(validatePresetToken('has space in it here').ok, false);
});

test('a valid token is trimmed, not rejected, for stray edge whitespace', () => {
  const r = validatePresetToken('  my-really-long-setup-token  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, 'my-really-long-setup-token');
});

console.log('\nDNS zone matching');

const { pickZone, wildcardRecordName } = require('../src/lib/dns-providers.js');

test('picks the longest matching zone, not the first', () => {
  const zones = [{ name: 'example.com' }, { name: 'apps.example.com' }, { name: 'other.com' }];
  // A delegated subdomain zone must win, or the record lands in the parent where
  // it will never be served.
  assert.strictEqual(pickZone(zones, 'apps.example.com').name, 'apps.example.com');
  assert.strictEqual(pickZone(zones, 'deep.apps.example.com').name, 'apps.example.com');
  assert.strictEqual(pickZone([{ name: 'example.com' }], 'apps.example.com').name, 'example.com');
});

test('does not match a zone that merely shares a suffix string', () => {
  // "notexample.com".endsWith("example.com") is true — matching on raw string
  // suffix would hand someone else's zone the record.
  assert.strictEqual(pickZone([{ name: 'example.com' }], 'notexample.com'), null);
  assert.strictEqual(pickZone([{ name: 'example.com' }], 'other.com'), null);
});

test('record name is relative to the zone', () => {
  assert.strictEqual(wildcardRecordName({ name: 'example.com' }, 'apps.example.com'), '*.apps');
  assert.strictEqual(wildcardRecordName({ name: 'example.com' }, 'a.b.example.com'), '*.a.b');
  // Base domain IS the zone: a bare wildcard, not "*." with an empty label.
  assert.strictEqual(wildcardRecordName({ name: 'example.com' }, 'example.com'), '*');
});

console.log('\nTOTP (RFC 6238)');

const totp = require('../src/lib/totp.js');

test('matches the RFC 6238 test vectors', () => {
  // Appendix B, SHA-1. The RFC prints 8 digits; we emit 6, so compare the tail.
  const seed = totp.base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [unix, expected] of vectors) {
    assert.strictEqual(totp.codeForStep(seed, Math.floor(unix / 30)), expected.slice(-6), `t=${unix}`);
  }
});

test('base32 round-trips', () => {
  const buf = Buffer.from('a slightly awkward length');
  assert.strictEqual(totp.base32Decode(totp.base32Encode(buf)).toString(), buf.toString());
});

test('a spent step cannot be reused', () => {
  const secret = totp.generateSecret();
  const step = totp.stepFor();
  const code = totp.codeForStep(secret, step);
  assert.strictEqual(totp.verify(secret, code).ok, true);
  // Same code, but the step is now recorded as spent.
  assert.strictEqual(totp.verify(secret, code, { lastStep: step }).ok, false);
});

test('accepts one step of clock drift either side, and nothing further', () => {
  const secret = totp.generateSecret();
  const now = totp.stepFor();
  assert.strictEqual(totp.verify(secret, totp.codeForStep(secret, now - 1)).ok, true);
  assert.strictEqual(totp.verify(secret, totp.codeForStep(secret, now + 1)).ok, true);
  assert.strictEqual(totp.verify(secret, totp.codeForStep(secret, now + 3)).ok, false);
});

test('malformed input is rejected before any crypto runs', () => {
  const secret = totp.generateSecret();
  ['', '12345', '1234567', 'abcdef', null].forEach((bad) =>
    assert.strictEqual(totp.verify(secret, bad).ok, false));
});

console.log('\nstructured app operations');

const ops = require('../src/runner/app-ops.js');

test('paths are contained to the app directory', () => {
  // The whole safety property: a caller names a path, so it must not be able to
  // name one outside the app — the runner's own filesystem holds the Docker socket
  // and every app's build.
  assert.doesNotThrow(() => ops.resolveInApp('notes', 'server/server.js'));
  assert.doesNotThrow(() => ops.resolveInApp('notes', '.'));
  ['../', '../../etc/passwd', 'a/../../..//etc/shadow', '/etc/passwd'].forEach((bad) =>
    assert.throws(() => ops.resolveInApp('notes', bad), /outside the app/, `should refuse ${bad}`));
});

test('a sibling app directory is not reachable by prefix', () => {
  // "notes-evil" starts with "notes"; a naive startsWith check would allow it.
  assert.throws(() => ops.resolveInApp('notes', '../notes-evil/secret'), /outside the app/);
});

test('only commands declared in app.json can be run', async () => {
  const app = { slug: 'notes', manifest: { scripts: { migrate: 'echo migrated' } } };
  assert.deepStrictEqual(ops.declaredCommands(app), ['migrate']);
  await assert.rejects(() => ops.runDeclared(app, [], 'rm -rf /'), /No such command/);
  await assert.rejects(() => ops.runDeclared({ slug: 'x', manifest: {} }, [], 'anything'), /declares no commands/);
});

test('runtime env reports whether secrets are set, never their values', () => {
  const vars = [{ key: 'OPENAI_API_KEY', kind: 'declared', value: 'sk-realvalue', isSecret: true }];
  const rows = ops.runtimeEnv({ ...internalApp, databaseMode: 'none', storageMode: 'none' }, vars);
  const secret = rows.find((r) => r.key === 'OPENAI_API_KEY');
  assert.strictEqual(secret.isSet, true, 'reports that it is set');
  assert.strictEqual(secret.value, null, 'never returns the value');
  assert.ok(secret.length > 0, 'length is useful for "did the whole thing paste"');
  const appSecret = rows.find((r) => r.key === 'ASTRODOCK_APP_SECRET');
  if (appSecret) assert.strictEqual(appSecret.value, null, 'platform secrets masked too');
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

// ── version + update comparison ──────────────────────────────────────────────

console.log('\nversion');

const version = require('../src/lib/version.js');

test('semver comparison orders releases correctly', () => {
  assert.ok(version.compare('0.0.5', '0.0.6') < 0);
  assert.ok(version.compare('0.0.6', '0.0.6') === 0);
  assert.ok(version.compare('0.1.0', '0.0.9') > 0);
  assert.ok(version.compare('1.0.0', '0.9.9') > 0);
  // Two-digit segments must not be compared as strings: "10" > "9".
  assert.ok(version.compare('0.0.9', '0.0.10') < 0);
  assert.ok(version.compare('0.9.0', '0.10.0') < 0);
});

test('a leading v is noise, not part of the version', () => {
  assert.strictEqual(version.compare('v0.0.6', '0.0.6'), 0);
  assert.strictEqual(version.normalize('v1.2.3'), '1.2.3');
});

test('a pre-release sorts before the release it belongs to', () => {
  assert.ok(version.compare('0.1.0-rc1', '0.1.0') < 0);
  assert.ok(version.compare('0.1.0', '0.1.0-rc1') > 0);
  assert.ok(version.compare('0.1.0-rc1', '0.1.0-rc2') < 0);
});

test('only real versions are treated as comparable', () => {
  assert.ok(version.isSemver('v0.0.6'));
  assert.ok(version.isSemver('1.2.3'));
  assert.ok(version.isSemver('0.1.0-rc1'));
  // "latest" is a tag, not a version — comparing against it would be nonsense.
  assert.ok(!version.isSemver('latest'));
  assert.ok(!version.isSemver(''));
  assert.ok(!version.isSemver(null));
  assert.ok(!version.isSemver('main'));
});

test('the build version does not come from the compose image-tag variable', () => {
  // docker-compose.yml reads ASTRODOCK_VERSION from the host .env to pick an
  // image tag, and every service does `env_file: .env` — so if the platform read
  // its own version from that name, a box pinned to :latest would report its
  // version as "latest". The baked-in value has its own name for that reason.
  const composeSrc = fs.readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
  assert.ok(composeSrc.includes('${ASTRODOCK_VERSION:-latest}'),
    'compose no longer selects the image tag this way — recheck the collision');
  const versionSrc = fs.readFileSync(new URL('../src/lib/version.js', import.meta.url), 'utf8');
  assert.ok(!/process\.env\.ASTRODOCK_VERSION\b/.test(versionSrc),
    'version.js must not read ASTRODOCK_VERSION: .env injects it into the container');
});

test('the package version matches what the image build would stamp', () => {
  // The fallback for a source build. It said 0.1.0 while the released tags were
  // v0.0.x, which would have made the update check call a fresh checkout "ahead".
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(version.isSemver(pkg.version), `package.json version "${pkg.version}" is not a version`);
});

// ── the suite must not depend on the shell it is run from ────────────────────

console.log('\ntest hygiene');

test('no integration test defaults its admin credentials from the environment', () => {
  // Three separate files seeded the admin with `ASTRODOCK_ADMIN_PASSWORD ||= ...`
  // and then logged in with a hard-coded literal. On a bare shell the two agreed
  // and everything passed; anywhere the variable was already set — every CI run —
  // the seed and the login disagreed and the suite failed with "Authentication
  // required". It went unnoticed for weeks because it never failed locally.
  const dir = new URL('.', import.meta.url);
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(new URL(name, dir), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (/process\.env\.ASTRODOCK_ADMIN_(EMAIL|PASSWORD)\s*\|\|=/.test(line)) {
        offenders.push(`${name}:${i + 1}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these pick up ambient credentials instead of pinning their own: ${offenders.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
