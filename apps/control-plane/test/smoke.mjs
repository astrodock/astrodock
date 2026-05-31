// Integration smoke test against a real (local) Postgres. Boots the express app
// on an ephemeral port and exercises the core control-plane flows end to end.
// Run: node test/smoke.mjs   (requires TOOLSTEAD_PG_* pointing at a live PG)

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { app } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { seedAdmin } = require('../src/seed.js');
const { db, schema, close } = require('../src/db/index.js');
const config = require('../src/config.js');
const { eq } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

// fresh slate
async function reset() {
  await migrate();
  await db.delete(schema.appEnvVars);
  await db.delete(schema.deployments);
  await db.delete(schema.apps);
  await db.delete(schema.apiTokens);
  await db.delete(schema.authLogs);
  await db.delete(schema.users);
  await seedAdmin({ log: () => {} });
}

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, json };
}

try {
  await reset();
  console.log('control-plane integration smoke');

  await test('GET /health', async () => {
    const r = await api('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ok');
  });

  let adminToken;
  await test('admin login works with seeded creds', async () => {
    const r = await api('POST', '/admin/login', { body: { email: 'admin@example.com', password: 'test-admin-password' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.token);
    adminToken = r.json.token;
  });

  await test('admin endpoints reject missing auth', async () => {
    const r = await api('GET', '/admin/apps');
    assert.strictEqual(r.status, 401);
  });

  await test('apply creates an internal-everything app + returns appSecret', async () => {
    const manifest = {
      schemaVersion: '1', slug: 'notes', name: 'Notes', subdomain: 'notes',
      source: { branch: 'main' }, runtime: { type: 'node' },
      auth: { mode: 'platform' }, database: { mode: 'internal' }, storage: { mode: 'none' }
    };
    const r = await api('POST', '/admin/apps/apply', { token: adminToken, body: { manifest } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.ok(r.json.appSecret, 'appSecret returned once');
    assert.strictEqual(r.json.app.database.mode, 'internal');
    assert.ok(r.json.app.provisioned, 'app provisioned (internal DB created)');
  });

  let appSecret;
  await test('rotate-secret returns a new secret', async () => {
    const r = await api('POST', '/admin/apps/notes/rotate-secret', { token: adminToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.appSecret.startsWith('sk_'));
    appSecret = r.json.appSecret;
  });

  await test('create a user + grant access', async () => {
    const c = await api('POST', '/admin/users', { token: adminToken, body: { email: 'u@example.com', name: 'U', password: 'password123' } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.json));
    const id = c.json.user.id;
    const g = await api('PUT', `/admin/users/${id}/access/notes`, { token: adminToken });
    assert.strictEqual(g.status, 204);
  });

  await test('/verify: success for the right creds', async () => {
    const r = await api('POST', '/verify', { body: { email: 'u@example.com', password: 'password123', appId: 'notes', appSecret } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.email, 'u@example.com');
  });

  await test('/verify: bad app secret → 401', async () => {
    const r = await api('POST', '/verify', { body: { email: 'u@example.com', password: 'password123', appId: 'notes', appSecret: 'sk_wrong' } });
    assert.strictEqual(r.status, 401);
  });

  await test('/verify: bad password → 401', async () => {
    const r = await api('POST', '/verify', { body: { email: 'u@example.com', password: 'nope', appId: 'notes', appSecret } });
    assert.strictEqual(r.status, 401);
  });

  await test('external-DB app: deploy gate blocks with a clear message', async () => {
    const manifest = {
      schemaVersion: '1', slug: 'crm', name: 'CRM', subdomain: 'crm',
      source: { branch: 'main' }, runtime: { type: 'node', buildCommand: 'npm run build' },
      auth: { mode: 'platform' }, database: { mode: 'external' }, storage: { mode: 'none' }
    };
    const a = await api('POST', '/admin/apps/apply', { token: adminToken, body: { manifest } });
    assert.strictEqual(a.status, 201, JSON.stringify(a.json));
    // connect a fake repo directly in the DB so the deploy precondition passes
    await db.update(schema.apps).set({ githubRepo: 'acme/crm' }).where(eq(schema.apps.slug, 'crm'));
    config.github.pat = 'fake-pat-for-gate-test'; // config is read once at load; set on the singleton
    const d = await api('POST', '/admin/apps/crm/deploy', { token: adminToken });
    assert.strictEqual(d.status, 422, JSON.stringify(d.json));
    assert.ok(d.json.missing.some((m) => m.key === 'TOOLSTEAD_DATABASE_URL'), 'DB url flagged missing');
    config.github.pat = '';
  });

  await test('scoped token can read apps but NOT manage users', async () => {
    const mk = await api('POST', '/admin/tokens', { token: adminToken, body: { name: 'agent', scopes: ['deploy'] } });
    assert.strictEqual(mk.status, 201, JSON.stringify(mk.json));
    const tk = mk.json.token;
    assert.ok(tk.startsWith('tk_'));
    const apps = await api('GET', '/admin/apps', { token: tk });
    assert.strictEqual(apps.status, 200, 'token can list apps');
    const users = await api('GET', '/admin/users', { token: tk });
    assert.strictEqual(users.status, 403, 'token cannot manage users');
  });

  await test('token cannot be granted users scope', async () => {
    const r = await api('POST', '/admin/tokens', { token: adminToken, body: { name: 'bad', scopes: ['users'] } });
    assert.strictEqual(r.status, 400);
  });

} finally {
  server.close();
  await close().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
