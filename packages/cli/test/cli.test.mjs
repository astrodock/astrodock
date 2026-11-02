// CLI integration test: boots the real control plane in-process, then drives
// the `astrodock` CLI as real subprocesses against it.
// Run from repo root with the test Postgres env loaded by the control plane's .env:
//   node --env-file=apps/control-plane/.env packages/cli/test/cli.test.mjs
// (or just `node packages/cli/test/cli.test.mjs` — it requires the control plane,
//  which loads apps/control-plane/.env itself.)

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const pexec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const cpDir = path.join(repoRoot, 'apps/control-plane');
const require = createRequire(path.join(cpDir, 'server.js'));

// load control-plane env explicitly (so this test works from repo root too)
require('dotenv').config({ path: path.join(cpDir, '.env') });

// Pin a base domain before config loads: empty now means "first-run setup pending",
// and these tests drive a configured platform (apps, deploys, app URLs).
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';

// These tests seed and then log in as this admin, so pin the credentials rather
// than inheriting whatever ASTRODOCK_ADMIN_* the environment happens to carry —
// a gitignored .env or CI's own values would otherwise decide whether login works.
process.env.ASTRODOCK_ADMIN_EMAIL = 'admin@example.com';
process.env.ASTRODOCK_ADMIN_PASSWORD = 'test-admin-password';

const { app } = require(path.join(cpDir, 'server.js'));
const { migrate } = require(path.join(cpDir, 'src/db/migrate.js'));
const { seedAdmin } = require(path.join(cpDir, 'src/seed.js'));
const { db, schema, close } = require(path.join(cpDir, 'src/db/index.js'));

const BIN = path.join(repoRoot, 'packages/cli/bin/astrodock.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

await migrate();
for (const t of [schema.appEnvVars, schema.deployments, schema.apps, schema.apiTokens, schema.authLogs, schema.approvals, schema.cliLogins, schema.users]) await db.delete(t);
await seedAdmin({ log: () => {} });

const config = require(path.join(cpDir, 'src/config.js'));
config.runnerToken = config.runnerToken || 'test-runner-token';
const { app: runnerApp } = require(path.join(cpDir, 'src/runner/server.js'));
const runnerServer = runnerApp.listen(0);
await new Promise((r) => runnerServer.once('listening', r));
config.runnerUrl = `http://127.0.0.1:${runnerServer.address().port}`;

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}`;

// login + mint a scoped token via the API
async function api(method, p, body, token) {
  const res = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
const { token: adminJwt } = await api('POST', '/admin/login', { email: 'admin@example.com', password: 'test-admin-password' });
const mk = await api('POST', '/admin/tokens', { name: 'cli', scopes: ['deploy'] }, adminJwt);
const scoped = mk.token;

// Approvals ask for an authenticator code (or a passkey), so the admin gets one.
// Each code is spendable once, so the last spent step is cleared before each use.
const totp = require(path.join(cpDir, 'src/lib/totp.js'));
const { eq } = require('drizzle-orm');
const { secret: totpSecret } = await api('POST', '/admin/account/totp/begin', {}, adminJwt);
await api('POST', '/admin/account/totp/confirm', { code: totp.codeForStep(totpSecret, totp.stepFor()) }, adminJwt);
async function freshCode() {
  await db.update(schema.users).set({ totpLastStep: null }).where(eq(schema.users.email, 'admin@example.com'));
  return totp.codeForStep(totpSecret, totp.stepFor());
}
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting');
}

// temp app dir with app.json
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-cli-'));
fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
  schemaVersion: '1', slug: 'cliapp', name: 'CLI App', subdomain: 'cliapp',
  source: { branch: 'main' }, runtime: { type: 'node' },
  auth: { mode: 'platform' }, database: { mode: 'internal' }, storage: { mode: 'none' },
  env: [{ key: 'OPENAI_API_KEY', secret: true, required: true, description: 'demo secret' }]
}, null, 2));

async function cli(args, { expectFail = false, cwd = dir } = {}) {
  try {
    const { stdout, stderr } = await pexec('node', [BIN, ...args], {
      cwd, encoding: 'utf8',
      env: { ...process.env, ASTRODOCK_URL: url, ASTRODOCK_TOKEN: scoped, ASTRODOCK_NO_BROWSER: '1' }
    });
    if (expectFail) throw new Error(`expected non-zero exit but got success:\n${stdout}`);
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    if (!expectFail && e.code === undefined) throw e;
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

try {
  console.log('astrodock CLI integration');

  await test('help works with no token/url', async () => {
    const { stdout } = await pexec('node', [BIN, 'help'], { encoding: 'utf8', env: { ...process.env, ASTRODOCK_URL: '', ASTRODOCK_TOKEN: '' } });
    assert.ok(stdout.includes('astrodock — drive an Astrodock platform'));
  });

  await test('apply creates the app from app.json + provisions, once a person approves', async () => {
    // A key creating an app needs approval. The CLI prints the link and waits.
    const running = cli(['apply']);
    const approval = await waitFor(async () => {
      const r = await api('GET', '/admin/approvals', null, adminJwt);
      return (r.approvals || []).find((a) => a.kind === 'app.create' && a.details.slug === 'cliapp');
    });
    const refused = await api('POST', `/admin/approvals/${approval.id}/approve`, { password: 'test-admin-password' }, adminJwt);
    assert.strictEqual(refused.code, 'proof_required', 'a password is not enough to approve');
    const ok = await api('POST', `/admin/approvals/${approval.id}/approve`, { totp: await freshCode() }, adminJwt);
    assert.strictEqual(ok.approval.status, 'approved', JSON.stringify(ok));
    const { code, out } = await running;
    assert.strictEqual(code, 0, out);
    assert.ok(out.includes('needs your approval'), out);
    assert.ok(out.includes('Created "cliapp"'), out);
    assert.ok(out.includes('app secret (shown once)'), out);
  });

  await test('applying again to the app that now exists needs no approval', async () => {
    const { code, out } = await cli(['apply']);
    assert.strictEqual(code, 0, out);
    assert.ok(out.includes('Updated "cliapp"'), out);
    assert.ok(!out.includes('needs your approval'), out);
  });

  await test('login writes a key for this app to .env.astrodock and ignores it in git', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-login-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.copyFileSync(path.join(dir, 'app.json'), path.join(repo, 'app.json'));
    const env = { ...process.env, ASTRODOCK_NO_BROWSER: '1' };
    delete env.ASTRODOCK_URL; delete env.ASTRODOCK_TOKEN;
    const running = pexec('node', [BIN, 'login', '--url', url], { cwd: repo, encoding: 'utf8', env });
    const row = await waitFor(async () => {
      const [r] = await db.select().from(schema.cliLogins).where(eq(schema.cliLogins.status, 'pending'));
      return r;
    });
    const code = `${row.userCode.slice(0, 4)}-${row.userCode.slice(4)}`;
    const seen = await api('GET', `/admin/cli-logins/${code}`, null, adminJwt);
    assert.strictEqual(seen.login.manifest.slug, 'cliapp');
    assert.strictEqual(seen.login.client.folder, path.basename(repo));
    const ok = await api('POST', `/admin/cli-logins/${code}/approve`, { kind: 'app', slug: 'cliapp', totp: await freshCode() }, adminJwt);
    assert.strictEqual(ok.login.status, 'approved', JSON.stringify(ok));
    const { stdout } = await running;
    assert.ok(stdout.includes('works for "cliapp" only'), stdout);
    const file = path.join(repo, '.env.astrodock');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const creds = fs.readFileSync(file, 'utf8');
    assert.ok(creds.includes(`ASTRODOCK_URL=${url}`), creds);
    const key = /ASTRODOCK_TOKEN=(tk_\S+)/.exec(creds)[1];
    assert.ok(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').includes('.env.astrodock'));
    const me = await api('GET', '/whoami', null, key);
    assert.deepStrictEqual(me.apps, ['cliapp']);
    assert.ok(!me.scopes.includes('pages:write'), 'a one-app key cannot publish pages');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  await test('apps lists the new app', async () => {
    const { code, out } = await cli(['apps']);
    assert.strictEqual(code, 0, out);
    assert.ok(out.includes('cliapp'), out);
    assert.ok(out.includes('provisioned'), out);
  });

  await test('set-secret stores a declared secret value', async () => {
    const { code, out } = await cli(['set-secret', 'OPENAI_API_KEY', 'sk-test-123', 'cliapp']);
    assert.strictEqual(code, 0, out);
    assert.ok(out.includes('Set OPENAI_API_KEY'), out);
  });

  await test('status returns process info', async () => {
    const { code, out } = await cli(['status', 'cliapp']);
    assert.strictEqual(code, 0, out);
    assert.ok(out.includes('status'), out);
  });

  await test('deploy is blocked (no PAT/repo) with a clear message', async () => {
    const { code, out } = await cli(['deploy', 'cliapp'], { expectFail: true });
    assert.notStrictEqual(code, 0);
    assert.ok(/repo|PAT|GitHub/i.test(out), out);
  });

  await test('invalid app.json is rejected before any API call', async () => {
    const baddir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-bad-'));
    fs.writeFileSync(path.join(baddir, 'app.json'), JSON.stringify({ schemaVersion: '1', slug: 'Bad Slug' }));
    const { code, out } = await cli(['apply'], { expectFail: true, cwd: baddir });
    assert.notStrictEqual(code, 0);
    assert.ok(/validation/i.test(out), out);
  });

} finally {
  server.close();
  runnerServer.close();
  await close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
