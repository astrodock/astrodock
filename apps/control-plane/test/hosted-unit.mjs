// Hosted mode, the parts with no database: caps, the container build scripts,
// traffic counting, routing upstreams, approval hashing, sign-in codes.
// Run: node test/hosted-unit.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(CP, 'server.js'));
process.env.ASTRODOCK_BASE_DOMAIN ||= 'example.test';
process.env.ASTRODOCK_TLS_MODE ||= 'off';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const iso = require(CP + '/src/lib/isolation.js');
const config = require(CP + '/src/config.js');

console.log('caps');
test('defaults apply when an app sets nothing', () => {
  const l = iso.limitsFor({});
  assert.strictEqual(l.memoryMb, config.limits.memoryMbDefault);
  assert.strictEqual(l.cpuMillis, config.limits.cpuMillisDefault);
  assert.deepStrictEqual(l.custom, { memory: false, cpu: false });
});
test('an app\'s own values are clamped to the maximum', () => {
  const l = iso.limitsFor({ memoryMb: 10 ** 7, cpuMillis: 10 ** 7 });
  assert.strictEqual(l.memoryMb, config.limits.memoryMbMax);
  assert.strictEqual(l.cpuMillis, config.limits.cpuMillisMax);
});
test('docker gets memory with no swap, and CPUs as a decimal', () => {
  const args = iso.dockerLimitArgs({ memoryMb: 768, cpuMillis: 1500 });
  assert.deepStrictEqual(args, ['--memory', '768m', '--memory-swap', '768m', '--cpus', '1.50']);
});
test('a typed cap must be a whole number in range; blank clears it', () => {
  const opts = { min: 64, max: 4096, label: 'Memory' };
  assert.strictEqual(iso.parseLimit('512', opts), 512);
  assert.strictEqual(iso.parseLimit('', opts), null);
  assert.strictEqual(iso.parseLimit(null, opts), null);
  assert.throws(() => iso.parseLimit('1.5', opts), /whole number/);
  assert.throws(() => iso.parseLimit('10', opts), /between/);
});
test('only containers count as isolated', () => {
  assert.ok(iso.inContainer({ runtimeType: 'docker' }));
  assert.ok(iso.inContainer({ runtimeType: 'node', nodeIsolation: 'container' }));
  assert.ok(!iso.inContainer({ runtimeType: 'node', nodeIsolation: 'pm2' }));
});
test('an install that sets nothing keeps PM2', () => {
  assert.strictEqual(config.deploy.nodeRuntime, process.env.ASTRODOCK_NODE_RUNTIME === 'container' ? 'container' : 'pm2');
});

console.log('\nNode apps in a container');
const nc = require(CP + '/src/runner/node-container.js');
test('layout finds app/ and server/, or a single package', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-'));
  fs.mkdirSync(path.join(d, 'app')); fs.mkdirSync(path.join(d, 'server'));
  assert.deepStrictEqual(nc.layout(d), { appRel: 'app', serverRel: 'server' });
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-'));
  fs.writeFileSync(path.join(s, 'server.js'), '');
  assert.deepStrictEqual(nc.layout(s), { appRel: null, serverRel: '.' });
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-'));
  fs.writeFileSync(path.join(a, 'package.json'), '{}');
  assert.deepStrictEqual(nc.layout(a), { appRel: '.', serverRel: null });
  for (const x of [d, s, a]) fs.rmSync(x, { recursive: true, force: true });
});
const scripts = nc.buildScripts({ appRel: 'app', serverRel: 'server', buildCommand: 'npm run build', installs: { app: 'npm ci --include=dev', server: 'npm ci --omit=dev' } });
test('the environment file is read and deleted before any app code runs', () => {
  const lines = scripts.root.split('\n');
  const read = lines.findIndex((l) => l.includes('. /tmp/astrodock-build.env'));
  const del = lines.findIndex((l) => l.includes('rm -f /tmp/astrodock-build.env'));
  const drop = lines.findIndex((l) => l.includes('setpriv'));
  assert.ok(read >= 0 && del > read && drop > del, scripts.root);
});
test('the build runs as uid 1000, never root', () => {
  assert.match(scripts.root, /exec setpriv --reuid=1000 --regid=1000 --clear-groups sh \/tmp\/astrodock-build\.sh/);
  assert.ok(!scripts.build.includes('setpriv'));
});
test('a .env in the repository is removed before the server installs', () => {
  const b = scripts.build.split('\n');
  assert.ok(b.indexOf('rm -f .env') > b.indexOf('cd /src/server'));
});
test('the build container has internet only, and is capped', () => {
  const src = fs.readFileSync(CP + '/src/runner/node-container.js', 'utf8');
  assert.match(src, /'--network', 'bridge'/);
  assert.match(src, /'--cap-drop', 'ALL'/);
  assert.match(src, /'--pids-limit', '4096'/);
});
test('the runtime container is capped, has no capabilities, and gets env from a file', () => {
  const src = fs.readFileSync(CP + '/src/runner/node-container.js', 'utf8');
  const run = /docker\(\['run', '-d'[\s\S]*?\]\);/.exec(src);
  assert.ok(run, 'could not find the docker run');
  for (const want of ['dockerLimitArgs(app)', "'--cap-drop', 'ALL'", "'--security-opt', 'no-new-privileges'", "'--env-file', envFile", "'--init'"]) {
    assert.ok(run[0].includes(want), `missing ${want}`);
  }
});
test('Dockerfile apps get the same caps', () => {
  const src = fs.readFileSync(CP + '/src/runner/deploy-worker.js', 'utf8');
  assert.match(src, /dockerLimitArgs\(app\)\.join\(' '\)/);
});

console.log('\ntraffic');
const tr = require(CP + '/src/runner/traffic.js');
test('totals add every interface', () => {
  assert.deepStrictEqual(tr.totals({ networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } } }), { rx: 11, tx: 22 });
  assert.deepStrictEqual(tr.totals({}), { rx: 0, tx: 0 });
});
test('the first sample, a restart, or a new container is a baseline, not traffic', () => {
  assert.deepStrictEqual(tr.delta(null, { id: 'a', rx: 100, tx: 100 }), { rx: 0, tx: 0 });
  assert.deepStrictEqual(tr.delta({ id: 'a', rx: 100, tx: 100 }, { id: 'a', rx: 5, tx: 5 }), { rx: 0, tx: 0 });
  assert.deepStrictEqual(tr.delta({ id: 'a', rx: 100, tx: 100 }, { id: 'b', rx: 500, tx: 500 }), { rx: 0, tx: 0 });
  assert.deepStrictEqual(tr.delta({ id: 'a', rx: 100, tx: 100 }, { id: 'a', rx: 150, tx: 400 }), { rx: 50, tx: 300 });
});
test('hours are whole UTC hours', () => {
  const h = tr.hourOf(new Date('2026-11-02T10:47:13Z'));
  assert.strictEqual(h.toISOString(), '2026-11-02T10:00:00.000Z');
});

console.log('\nrouting');
const { generateCaddyfile } = require(CP + '/src/provision/caddy.js');
test('a Node app in a container is proxied to its container', () => {
  const out = generateCaddyfile([{ slug: 'box', subdomain: 'box', port: 3105, runtimeType: 'node', nodeIsolation: 'container', spa: true }]);
  assert.match(out, /reverse_proxy app-box:3105/);
});
test('a Node app under PM2 is still proxied to the runner', () => {
  const out = generateCaddyfile([{ slug: 'box', subdomain: 'box', port: 3105, runtimeType: 'node', nodeIsolation: 'pm2', spa: true }]);
  assert.match(out, /reverse_proxy runner:3105/);
  assert.ok(!out.includes('app-box'));
});
test('a custom domain follows where its app runs', () => {
  const out = generateCaddyfile([{ slug: 'box', subdomain: 'box', port: 3105, runtimeType: 'node', nodeIsolation: 'container', spa: true }],
    { domains: [{ hostname: 'box.example.org', appSlug: 'box', runtimeType: 'node', nodeIsolation: 'container', port: 3105 }] });
  const block = out.slice(out.indexOf('box.example.org'));
  assert.match(block, /reverse_proxy app-box:3105/);
});
test('the admin host sends /cli and /fleet to the API', () => {
  const out = generateCaddyfile([]);
  assert.match(out, /handle \/cli\/\*/);
  assert.match(out, /handle \/fleet\/\*/);
});

console.log('\napprovals and sign-in codes');
const approvals = require(CP + '/src/lib/approvals.js');
const cli = require(CP + '/src/lib/cli-login.js');
test('the request hash does not depend on key order', () => {
  const a = approvals.requestHash({ method: 'POST', baseUrl: '/admin/apps', path: '/apply', body: { b: 1, a: { y: 2, x: [1, { q: 1, p: 2 }] } } });
  const b = approvals.requestHash({ method: 'POST', baseUrl: '/admin/apps', path: '/apply', body: { a: { x: [1, { p: 2, q: 1 }], y: 2 }, b: 1 } });
  assert.strictEqual(a, b);
});
test('but does depend on the route and the values', () => {
  const base = { method: 'POST', baseUrl: '/admin/apps', path: '/apply', body: { slug: 'x' } };
  assert.notStrictEqual(approvals.requestHash(base), approvals.requestHash({ ...base, path: '/' }));
  assert.notStrictEqual(approvals.requestHash(base), approvals.requestHash({ ...base, body: { slug: 'y' } }));
});
test('user codes read the same however they are typed', () => {
  assert.strictEqual(cli.normalizeUserCode('bcdf-ghjk'), 'BCDFGHJK');
  assert.strictEqual(cli.formatUserCode('BCDFGHJK'), 'BCDF-GHJK');
});
test('the verifier has to hash to the challenge', () => {
  const crypto = require('crypto');
  const v = crypto.randomBytes(32).toString('base64url');
  const c = crypto.createHash('sha256').update(v).digest('base64url');
  assert.ok(cli.verifierMatches(v, c));
  assert.ok(!cli.verifierMatches(crypto.randomBytes(32).toString('base64url'), c));
  assert.ok(!cli.verifierMatches('short', c));
});
test('key names say what they are for and where they came from', () => {
  assert.strictEqual(cli.keyName({ kind: 'app', appSlug: 'notes', client: { hostname: 'laptop' } }), 'astrodock login · notes · laptop');
  assert.strictEqual(cli.keyName({ kind: 'account', client: {} }), 'astrodock login · All Apps · CLI');
});
test('the login presets never carry key minting, deletion or commands', () => {
  const { PRESETS } = require(CP + '/src/lib/scopes.js');
  for (const k of ['agent', 'agentAccount']) {
    for (const s of ['tokens:write', 'apps:delete', 'exec', 'server:exec', 'settings:write', 'backups:write', 'feedback:reply']) {
      assert.ok(!PRESETS[k].scopes.includes(s), `${k} has ${s}`);
    }
  }
  assert.ok(!PRESETS.agent.scopes.includes('pages:write'), 'pages are not part of any one app');
});

console.log('\ncookies an app on a sibling subdomain cannot plant');
test('over HTTPS the sign-in and Pages cookies carry the __Host- prefix', () => {
  const us = require(CP + '/src/lib/user-session.js');
  const pg = require(CP + '/src/lib/pages.js');
  const was = config.tlsMode;
  try {
    config.tlsMode = 'auto';
    assert.strictEqual(us.COOKIE, '__Host-ad_user_session');
    assert.strictEqual(pg.SESSION_COOKIE, '__Host-ad_pages_session');
    assert.strictEqual(pg.PASSKEY_COOKIE('abc'), '__Host-ad_pk_abc');
    const o = us.options();
    assert.ok(o.secure && o.path === '/' && !o.domain, 'what the prefix requires');
    config.tlsMode = 'off';
    assert.strictEqual(us.COOKIE, 'ad_user_session', 'plain HTTP keeps the bare name');
  } finally { config.tlsMode = was; }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
