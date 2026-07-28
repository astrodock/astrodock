// Pages integration tests against a live local Postgres (store-free paths: admin CRUD,
// scope boundaries, access-mode rules, and the per-page data blob via the pages host).
// File upload/serving (object store) is verified separately on the docker stack.
//
//   ASTRODOCK_PG_HOST=localhost ASTRODOCK_PG_PORT=55432 ASTRODOCK_PG_USER=astrodock \
//   ASTRODOCK_PG_PASSWORD=astrodock ASTRODOCK_PG_DATABASE=astrodock node test/pages.test.mjs

import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'pages-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'pages-test-secret';
// Pinned, not defaulted. `||=` let an ambient ASTRODOCK_ADMIN_PASSWORD decide what
// the admin is seeded with while the login below still sent 'adminpass' — so the
// suite passed on a bare shell and failed anywhere the variable was set, which is
// every CI run. Same trap that smoke.mjs and cli.test.mjs were in.
process.env.ASTRODOCK_ADMIN_EMAIL = 'admin@example.com';
process.env.ASTRODOCK_ADMIN_PASSWORD = 'adminpass';
process.env.ASTRODOCK_BASE_DOMAIN = 'localhost';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ENV = 'development';

const { app } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { seedAdmin } = require('../src/seed.js');
const { db, schema, close } = require('../src/db/index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate();
for (const t of [schema.pageData, schema.pageFiles, schema.pages, schema.apiTokens, schema.users]) await db.delete(t);
await seedAdmin({ log: () => {} });

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const PAGES_HOST = 'pages.localhost';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; const txt = await res.text(); if (txt) try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, json };
}

// raw request against the pages host (controls Host header + cookies)
function pagesReq(method, path, { json, form, cookie } = {}) {
  return new Promise((resolve, reject) => {
    let data, ctype;
    if (json !== undefined) { data = JSON.stringify(json); ctype = 'application/json'; }
    else if (form) { data = new URLSearchParams(form).toString(); ctype = 'application/x-www-form-urlencoded'; }
    const headers = { Host: PAGES_HOST };
    if (data) { headers['Content-Type'] = ctype; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: j });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

try {
  console.log('pages integration');
  const adminJwt = (await api('POST', '/admin/login', { body: { email: 'admin@example.com', password: 'adminpass' } })).json.token;
  const pagesTok = (await api('POST', '/admin/tokens', { token: adminJwt, body: { name: 'p', scopes: ['pages'] } })).json.token;
  const deployTok = (await api('POST', '/admin/tokens', { token: adminJwt, body: { name: 'd', scopes: ['deploy'] } })).json.token;

  await test('create a bare page', async () => {
    const r = await api('POST', '/admin/pages', { token: adminJwt, body: { title: 'My Doc' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.match(r.json.page.pageId, /^[a-z0-9]{12}$/);
    assert.ok(r.json.page.url.includes('pages.localhost'));
  });

  await test('pages-scoped token works on /admin/pages but not /admin/apps', async () => {
    assert.strictEqual((await api('GET', '/admin/pages', { token: pagesTok })).status, 200);
    assert.strictEqual((await api('GET', '/admin/apps', { token: pagesTok })).status, 403);
  });
  await test('deploy-scoped token is rejected on /admin/pages', async () => {
    assert.strictEqual((await api('GET', '/admin/pages', { token: deployTok })).status, 403);
  });

  await test('access-mode rules enforced', async () => {
    const p = (await api('POST', '/admin/pages', { token: pagesTok, body: { title: 'rules' } })).json.page;
    assert.strictEqual((await api('PATCH', `/admin/pages/${p.pageId}`, { token: pagesTok, body: { dataMode: 'shared' } })).status, 400); // public + data
    assert.strictEqual((await api('PATCH', `/admin/pages/${p.pageId}`, { token: pagesTok, body: { accessMode: 'passkey', dataMode: 'shared' } })).status, 200);
    const bad = await api('POST', '/admin/pages', { token: pagesTok, body: { title: 'pu', accessMode: 'passkey', dataMode: 'per-user' } });
    assert.strictEqual(bad.status, 400); // per-user requires platform
  });

  let passkeyPage, passkey;
  await test('create a passkey + shared-data page', async () => {
    const r = await api('POST', '/admin/pages', { token: pagesTok, body: { title: 'list', accessMode: 'passkey', generatePasskey: true, dataMode: 'shared' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    passkeyPage = r.json.page.pageId; passkey = r.json.page.passkey;
    assert.ok(passkey, 'passkey returned once');
  });

  await test('_data write blocked without the passkey', async () => {
    const r = await pagesReq('PUT', `/${passkeyPage}/_data`, { json: { data: { x: 1 } } });
    assert.strictEqual(r.status, 401, r.body);
  });
  await test('_data write+read with the passkey (?key=)', async () => {
    const w = await pagesReq('PUT', `/${passkeyPage}/_data?key=${encodeURIComponent(passkey)}`, { json: { data: { checked: [1, 2] } } });
    assert.strictEqual(w.status, 200, w.body);
    assert.strictEqual(w.json.version, 1);
    const g = await pagesReq('GET', `/${passkeyPage}/_data?key=${encodeURIComponent(passkey)}`);
    assert.deepStrictEqual(g.json.data, { checked: [1, 2] });
    assert.strictEqual(g.json.version, 1);
  });
  await test('_data version conflict → 409', async () => {
    const r = await pagesReq('PUT', `/${passkeyPage}/_data?key=${encodeURIComponent(passkey)}`, { json: { data: { x: 9 }, version: 0 } });
    assert.strictEqual(r.status, 409, r.body);
  });
  await test('_data over the size cap → 413', async () => {
    const big = 'x'.repeat(1_500_000);
    const r = await pagesReq('PUT', `/${passkeyPage}/_data?key=${encodeURIComponent(passkey)}`, { json: { data: { big } } });
    assert.strictEqual(r.status, 413, r.body);
  });

  await test('platform per-user data: login → write → read own blob', async () => {
    const p = (await api('POST', '/admin/pages', { token: pagesTok, body: { title: 'peruser', accessMode: 'platform', dataMode: 'per-user' } })).json.page;
    const login = await pagesReq('POST', `/${p.pageId}/_login`, { form: { email: 'admin@example.com', password: 'adminpass' } });
    assert.strictEqual(login.status, 302, login.body);
    const setCookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    assert.ok(setCookie.includes('ad_pages_session'), 'session cookie set');
    const w = await pagesReq('PUT', `/${p.pageId}/_data`, { json: { data: { note: 'mine' } }, cookie: setCookie });
    assert.strictEqual(w.status, 200, w.body);
    const g = await pagesReq('GET', `/${p.pageId}/_data`, { cookie: setCookie });
    assert.deepStrictEqual(g.json.data, { note: 'mine' });
    // no cookie → blocked
    assert.strictEqual((await pagesReq('GET', `/${p.pageId}/_data`)).status, 401);
  });

  await test('admin paths are 404 on the pages host', async () => {
    const r = await pagesReq('GET', '/admin/pages');
    assert.strictEqual(r.status, 404, r.body);
  });

} finally {
  server.close();
  await close().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
