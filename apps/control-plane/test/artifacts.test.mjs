// Artifacts integration tests against a live local Postgres: management API,
// sign-in (silent for account members, email code for guests), the data API
// with its rules, live updates, revocation, and capability feedback.
// The object store is replaced by an in-memory one, so file serving is covered.
//
//   ASTRODOCK_PG_HOST=localhost ASTRODOCK_PG_PORT=55432 ASTRODOCK_PG_USER=astrodock \
//   ASTRODOCK_PG_PASSWORD=astrodock ASTRODOCK_PG_DATABASE=astrodock node test/artifacts.test.mjs
//
// It empties the artifact tables, users and tokens of the database it points at.

import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'artifacts-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'artifacts-test-secret';
process.env.ASTRODOCK_ADMIN_EMAIL = 'admin@example.com';
process.env.ASTRODOCK_ADMIN_PASSWORD = 'adminpass';
process.env.ASTRODOCK_BASE_DOMAIN = 'localhost';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ENV = 'development';
process.env.ASTRODOCK_ACCEPT_UPSTREAM_FEEDBACK = 'on';
process.env.ASTRODOCK_FLEET_TOKEN = 'fleet-test-token-0123456789';
process.env.ASTRODOCK_ARTIFACTS_SERVICE = 'on';
delete process.env.ASTRODOCK_ARTIFACTS_DOMAIN;

// Capture mail instead of sending it. Patched before the routes load, since
// they take sendEmail when they are required.
const mail = [];
const email = require('../src/lib/email.js');
email.sendEmail = async (m) => { mail.push(m); return { id: 'test' }; };
const emailConfig = require('../src/lib/email-config.js');
emailConfig.isUsable = () => true;

// The object store, in memory.
const objects = new Map();
const store = require('../src/lib/pages-store.js');
store.putFile = async (id, name, body, contentType) => { objects.set(`${id}/${name}`, { body: Buffer.from(body), contentType }); };
store.getFile = async (id, name) => objects.get(`${id}/${name}`) || null;
store.deleteFile = async (id, name) => { objects.delete(`${id}/${name}`); };
store.deleteAll = async (id) => { for (const k of objects.keys()) if (k.startsWith(`${id}/`)) objects.delete(k); };

const config = require('../src/config.js');
const { app } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { seedAdmin } = require('../src/seed.js');
const { db, schema, close } = require('../src/db/index.js');
const { eq } = require('drizzle-orm');
const userSession = require('../src/lib/user-session.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate({ log: () => {} });
for (const t of [schema.artifactViews, schema.artifactApiLog, schema.artifactReadCounts, schema.artifactSignins, schema.artifactErrors,
  schema.artifactRevisions, schema.artifactReports, schema.artifactAccounts, schema.artifactFeedback, schema.artifactSends, schema.artifactGrants, schema.artifactCodes, schema.artifactBlobs,
  schema.artifactRecords, schema.artifactShares, schema.artifactFiles, schema.artifacts, schema.artifactFolders,
  schema.apiTokens, schema.sessions, schema.events, schema.users]) await db.delete(t);
await seedAdmin({ log: () => {} });

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
config.artifacts.upstreamFeedbackUrl = `http://127.0.0.1:${port}/upstream/capability-feedback`;
const AUTH_HOST = 'auth.localhost';

// Requests with a chosen Host, cookies and Origin.
function req(method, path, { host = 'admin.localhost', json, form, cookie, token, origin } = {}) {
  return new Promise((resolve, reject) => {
    let data, ctype;
    if (json !== undefined) { data = JSON.stringify(json); ctype = 'application/json'; }
    else if (form) { data = new URLSearchParams(form).toString(); ctype = 'application/x-www-form-urlencoded'; }
    const headers = { Host: host };
    if (data) { headers['Content-Type'] = ctype; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const cookieFrom = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

try {
  console.log('artifacts integration');
  const adminJwt = (await req('POST', '/admin/login', { json: { email: 'admin@example.com', password: 'adminpass' } })).json.token;
  const tok = (await req('POST', '/admin/tokens', { token: adminJwt, json: { name: 'a', scopes: ['artifacts:read', 'artifacts:write'] } })).json.token;
  const readTok = (await req('POST', '/admin/tokens', { token: adminJwt, json: { name: 'r', scopes: ['artifacts:read'] } })).json.token;
  const pagesTok = (await req('POST', '/admin/tokens', { token: adminJwt, json: { name: 'p', scopes: ['pages:read', 'pages:write'] } })).json.token;

  const manifest = {
    roles: ['owner', 'manager', 'staff', 'viewer'],
    collections: {
      tasks: {
        read: ['manager', 'author', { field: 'assignee', is: 'me.email' }],
        create: 'staff',
        update: ['manager', 'author', { field: 'assignee', is: 'me.email' }],
        delete: ['owner', 'author'],
        fields: { title: { type: 'string', required: true }, done: 'boolean', assignee: 'email', completedAt: 'datetime' }
      },
      notes: { scope: 'per-user', create: 'viewer' },
      board: { read: ['public'], create: 'viewer' }
    },
    blobs: { settings: { read: 'viewer', write: 'owner' } },
    actions: [
      { on: 'tasks.create', do: 'email', to: { field: 'assignee' }, subject: 'New task: {{title}}' },
      { on: ['tasks.create', 'tasks.update'], do: 'stamp', field: 'completedAt', when: { field: 'done', is: true } }
    ]
  };

  let id, host, origin;
  await test('create: scope, manifest problems, owner', async () => {
    assert.strictEqual((await req('POST', '/admin/artifacts', { token: pagesTok, json: { title: 'x' } })).status, 403, 'pages scope is not artifacts');
    assert.strictEqual((await req('POST', '/admin/artifacts', { token: readTok, json: { title: 'x' } })).status, 403, 'read cannot create');
    const bad = await req('POST', '/admin/artifacts', { token: tok, json: { title: 'x', manifest: { roles: ['boss'] } } });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.json.problems.some((p) => p.path === 'roles[0]'));
    const r = await req('POST', '/admin/artifacts', { token: tok, json: { title: 'Team Tasks', manifest } });
    assert.strictEqual(r.status, 201, r.body);
    id = r.json.artifact.id;
    assert.match(id, /^[a-z0-9]{12}$/);
    assert.strictEqual(r.json.artifact.url, `http://${id}.artifacts.localhost/`);
    host = `${id}.artifacts.localhost`;
    origin = `http://${host}`;
    const list = await req('GET', '/admin/artifacts', { token: readTok });
    assert.deepStrictEqual(list.json.artifacts.map((a) => [a.id, a.access]), [[id, 'owner']]);
  });

  await test('guide is served to agents, with the feedback rule', async () => {
    const r = await req('GET', '/admin/artifacts/guide', { token: readTok });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /\/admin\/artifacts\/feedback/);
    assert.match(r.body, /<id>\.artifacts\.localhost/);
  });

  await test('an unknown artifact host is a 404; a known one sends strangers to sign in', async () => {
    assert.strictEqual((await req('GET', '/', { host: 'zzzzzzzzzzzz.artifacts.localhost' })).status, 404);
    const r = await req('GET', '/', { host });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/_astrodock/signin?next=%2F');
    const s = await req('GET', '/_astrodock/signin?next=/board', { host });
    assert.strictEqual(s.headers.location, `http://auth.localhost/artifacts/signin?a=${id}&next=%2Fboard`);
    assert.strictEqual((await req('GET', '/_astrodock/api/me', { host })).status, 401);
  });

  await test('sharing: roles checked, invites sent, duplicates and role changes', async () => {
    const bad = await req('POST', `/admin/artifacts/${id}/shares`, { token: tok, json: { emails: ['a@x.com'], role: 'boss' } });
    assert.strictEqual(bad.status, 400);
    mail.length = 0;
    const r = await req('POST', `/admin/artifacts/${id}/shares`, { token: tok, json: { emails: ['Sam@Example.com', 'viv@example.com'], role: 'staff' } });
    assert.strictEqual(r.status, 200, r.body);
    assert.deepStrictEqual(r.json.results.map((x) => [x.email, x.status, x.invite]), [['sam@example.com', 'added', 'sent'], ['viv@example.com', 'added', 'sent']]);
    assert.strictEqual(mail.length, 2);
    assert.match(mail[0].html, new RegExp(`http://${id}\\.artifacts\\.localhost`));
    const again = await req('POST', `/admin/artifacts/${id}/shares`, { token: tok, json: { emails: ['viv@example.com'], role: 'viewer', notify: false } });
    assert.strictEqual(again.json.results[0].status, 'role_changed');
    await req('POST', `/admin/artifacts/${id}/shares`, { token: tok, json: { emails: ['mo@example.com'], role: 'manager', notify: false } });
  });

  // Sign a guest in through the email code, and return their artifact cookie.
  async function guestSignIn(addr) {
    const page = await req('GET', `/artifacts/signin?a=${id}&next=/`, { host: AUTH_HOST });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /Send Code/);
    mail.length = 0;
    const sent = await req('POST', '/artifacts/signin/code', { host: AUTH_HOST, origin: 'http://auth.localhost', form: { a: id, next: '/', email: addr } });
    assert.strictEqual(sent.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const code = /(\d{6}) is your sign-in code/.exec(mail.at(-1)?.subject || '')?.[1];
    assert.ok(code, 'a code was emailed');
    const ok = await req('POST', '/artifacts/signin/verify', { host: AUTH_HOST, origin: 'http://auth.localhost', form: { a: id, next: '/', email: addr, code } });
    assert.strictEqual(ok.status, 302, ok.body);
    const back = new URL(ok.headers.location);
    assert.strictEqual(back.host, host);
    const cb = await req('GET', back.pathname + back.search, { host });
    assert.strictEqual(cb.status, 302);
    const cookie = cookieFrom(cb);
    assert.ok(cookie.startsWith('ad_artifact='), 'host-only artifact session');
    // The grant is spent.
    assert.strictEqual((await req('GET', back.pathname + back.search, { host })).status, 401);
    return cookie;
  }

  let sam, viv, mo;
  await test('guests sign in with an emailed code, once per artifact', async () => {
    sam = await guestSignIn('sam@example.com');
    viv = await guestSignIn('viv@example.com');
    mo = await guestSignIn('mo@example.com');
    const me = await req('GET', '/_astrodock/api/me', { host, cookie: sam });
    assert.strictEqual(me.json.role, 'staff');
    assert.strictEqual(me.json.email, 'sam@example.com');
    assert.deepStrictEqual(me.json.permissions.collections.tasks, { read: 'some', create: true, update: 'some', delete: 'some' });
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'sam@example.com'));
    assert.strictEqual(u.operatorRole, null, 'a guest is an end user, not an operator');
  });

  await test('codes: no hint whether an address has access, wrong codes and expiry', async () => {
    mail.length = 0;
    const r = await req('POST', '/artifacts/signin/code', { host: AUTH_HOST, origin: 'http://auth.localhost', form: { a: id, next: '/', email: 'stranger@example.com' } });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /If <b>stranger@example.com<\/b> has access/);
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(mail.length, 0, 'nothing is sent to an address without access');
    const wrong = await req('POST', '/artifacts/signin/verify', { host: AUTH_HOST, origin: 'http://auth.localhost', form: { a: id, next: '/', email: 'sam@example.com', code: '000000' } });
    assert.strictEqual(wrong.status, 401);
  });

  await test('an account member with a platform session is signed in without a code', async () => {
    const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, 'admin@example.com'));
    const platform = `${userSession.COOKIE}=${userSession.sign(admin)}`;
    const r = await req('GET', `/artifacts/signin?a=${id}&next=/x`, { host: AUTH_HOST, cookie: platform });
    assert.strictEqual(r.status, 302);
    const back = new URL(r.headers.location);
    assert.strictEqual(back.host, host);
    const cb = await req('GET', back.pathname + back.search, { host });
    assert.strictEqual(cb.headers.location, '/x');
    const me = await req('GET', '/_astrodock/api/me', { host, cookie: cookieFrom(cb) });
    assert.strictEqual(me.json.role, 'owner');
    // A guest with a platform session still gets the code page.
    const [g] = await db.select().from(schema.users).where(eq(schema.users.email, 'sam@example.com'));
    const gr = await req('GET', `/artifacts/signin?a=${id}`, { host: AUTH_HOST, cookie: `${userSession.COOKIE}=${userSession.sign(g)}` });
    assert.strictEqual(gr.status, 200);
    assert.match(gr.body, /Send Code/);
  });

  let taskId;
  await test('writes need the artifact\'s own Origin', async () => {
    const none = await req('POST', '/_astrodock/api/c/tasks', { host, cookie: sam, json: { title: 'x' } });
    assert.strictEqual(none.status, 403);
    const other = await req('POST', '/_astrodock/api/c/tasks', { host, cookie: sam, origin: 'http://otherartifact.artifacts.localhost', json: { title: 'x' } });
    assert.strictEqual(other.status, 403);
  });

  await test('records: create with validation, stamps, author and field rules', async () => {
    const W = { host, origin };
    const bad = await req('POST', '/_astrodock/api/c/tasks', { ...W, cookie: sam, json: { title: 3, colour: 'red' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.problems.length, 2);
    assert.strictEqual((await req('POST', '/_astrodock/api/c/tasks', { ...W, cookie: viv, json: { title: 'v' } })).status, 403, 'viewer cannot create');
    mail.length = 0;
    const r = await req('POST', '/_astrodock/api/c/tasks', { ...W, cookie: sam, json: { title: 'Call vendor', assignee: 'viv@example.com', done: true } });
    assert.strictEqual(r.status, 201, r.body);
    taskId = r.json.record.id;
    assert.strictEqual(r.json.record._author, 'sam@example.com');
    assert.ok(r.json.record.completedAt, 'stamped on create');
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(mail.map((m) => [m.to, m.subject]), [['viv@example.com', 'New task: Call vendor']], 'email action to the assignee');
    // A stranger named in an email field gets nothing.
    mail.length = 0;
    await req('POST', '/_astrodock/api/c/tasks', { ...W, cookie: sam, json: { title: 'Leak', assignee: 'stranger@example.com' } });
    await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(mail.length, 0);
    // viv reads it because it is assigned to her; mo (manager) reads everything.
    const vivList = await req('GET', '/_astrodock/api/c/tasks', { host, cookie: viv });
    assert.deepStrictEqual(vivList.json.records.map((x) => x.title), ['Call vendor']);
    const moList = await req('GET', '/_astrodock/api/c/tasks?order=-title', { host, cookie: mo });
    assert.deepStrictEqual(moList.json.records.map((x) => x.title), ['Leak', 'Call vendor']);
    const filtered = await req('GET', `/_astrodock/api/c/tasks?where=${encodeURIComponent(JSON.stringify({ done: true }))}`, { host, cookie: mo });
    assert.deepStrictEqual(filtered.json.records.map((x) => x.title), ['Call vendor']);
    // viv may update as assignee; the stamp clears when done turns false.
    const up = await req('PATCH', `/_astrodock/api/c/tasks/${taskId}`, { ...W, cookie: viv, json: { done: false, _version: 1 } });
    assert.strictEqual(up.status, 200, up.body);
    assert.strictEqual(up.json.record.completedAt, null);
    assert.strictEqual(up.json.record._version, 2);
    const stale = await req('PATCH', `/_astrodock/api/c/tasks/${taskId}`, { ...W, cookie: viv, json: { done: true, _version: 1 } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.current._version, 2);
    // viv cannot delete (owner or author only); sam (author) can, later.
    assert.strictEqual((await req('DELETE', `/_astrodock/api/c/tasks/${taskId}`, { ...W, cookie: viv })).status, 403);
    const counts = await req('GET', '/_astrodock/api/c/tasks/_count?by=done', { host, cookie: mo });
    assert.strictEqual(counts.json.total, 2);
  });

  await test('per-user collections and blobs', async () => {
    const W = { host, origin };
    await req('POST', '/_astrodock/api/c/notes', { ...W, cookie: sam, json: { text: 'sam private' } });
    await req('POST', '/_astrodock/api/c/notes', { ...W, cookie: viv, json: { text: 'viv private' } });
    const s = await req('GET', '/_astrodock/api/c/notes', { host, cookie: sam });
    assert.deepStrictEqual(s.json.records.map((x) => x.text), ['sam private']);
    const blob = await req('PUT', '/_astrodock/api/b/settings', { ...W, cookie: sam, json: { data: { a: 1 } } });
    assert.strictEqual(blob.status, 403, 'staff cannot write an owner blob');
    const read = await req('GET', '/_astrodock/api/b/settings', { host, cookie: viv });
    assert.deepStrictEqual(read.json, { data: {}, version: 0, updatedAt: null });
    assert.strictEqual((await req('GET', '/_astrodock/api/c/nope', { host, cookie: sam })).status, 404);
  });

  await test('live updates reach readers, filtered by their rules', async () => {
    const events = [];
    const stream = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/_astrodock/api/c/tasks/_stream', headers: { Host: host, Cookie: viv } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => { for (const m of c.matchAll(/data: (.*)\n\n/g)) events.push(JSON.parse(m[1])); });
        resolve({ res, r });
      });
      r.end();
    });
    assert.strictEqual(stream.res.statusCode, 200);
    await req('POST', '/_astrodock/api/c/tasks', { host, origin, cookie: sam, json: { title: 'For viv', assignee: 'viv@example.com' } });
    await req('POST', '/_astrodock/api/c/tasks', { host, origin, cookie: sam, json: { title: 'Not for viv' } });
    await new Promise((res) => setTimeout(res, 150));
    stream.r.destroy();
    assert.deepStrictEqual(events.map((e) => [e.type, e.record.title]), [['create', 'For viv']]);
  });

  await test('removing a share ends access at once', async () => {
    const r = await req('DELETE', `/admin/artifacts/${id}/shares?email=viv@example.com`, { token: tok });
    assert.strictEqual(r.status, 204);
    const me = await req('GET', '/_astrodock/api/me', { host, cookie: viv });
    assert.strictEqual(me.status, 401);
    assert.strictEqual((await req('GET', '/', { host, cookie: viv })).status, 302);
  });

  await test('ending every session signs everyone out; shares stay', async () => {
    await req('POST', `/admin/artifacts/${id}/sessions/revoke`, { token: tok });
    assert.strictEqual((await req('GET', '/_astrodock/api/me', { host, cookie: sam })).status, 401);
    sam = await guestSignIn('sam@example.com');
    assert.strictEqual((await req('GET', '/_astrodock/api/me', { host, cookie: sam })).json.role, 'staff');
  });

  await test('public artifacts: anyone reads what "public" allows, nothing more', async () => {
    await req('PATCH', `/admin/artifacts/${id}`, { token: tok, json: { visibility: 'public' } });
    await req('POST', '/_astrodock/api/c/board', { host, origin, cookie: sam, json: { msg: 'hello' } });
    const anon = await req('GET', '/_astrodock/api/c/board', { host });
    assert.deepStrictEqual(anon.json.records.map((x) => x.msg), ['hello']);
    assert.strictEqual((await req('GET', '/_astrodock/api/c/tasks', { host })).status, 403);
    assert.strictEqual((await req('POST', '/_astrodock/api/c/board', { host, origin, json: { msg: 'anon' } })).status, 401);
    await req('PATCH', `/admin/artifacts/${id}`, { token: tok, json: { visibility: 'shared' } });
  });

  await test('files: served on the artifact host with the client script added', async () => {
    const put = await req('PUT', `/admin/artifacts/${id}/files`, { token: tok, json: { files: [
      { name: 'index.html', content: '<!doctype html><html><head><title>T</title></head><body>Hi</body></html>' },
      { name: 'app.js', content: 'console.log(1)' }
    ] } });
    assert.strictEqual(put.status, 200, put.body);
    const page = await req('GET', '/', { host, cookie: sam });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<head><script src="\/_astrodock\/client\.js"><\/script><title>T<\/title>/);
    const js = await req('GET', '/app.js', { host, cookie: sam });
    assert.strictEqual(js.body, 'console.log(1)', 'only HTML gets the script');
    const spa = await req('GET', '/some/route', { host, cookie: sam });
    assert.match(spa.body, /Hi/, 'a path with no extension serves the entry file');
  });

  await test('logging: views, writes, failures, read counts, sign-ins', async () => {
    const logs = require('../src/lib/artifacts/logs.js');
    const [a] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.publicId, id));
    await new Promise((r) => setTimeout(r, 100));
    const views = await db.select().from(schema.artifactViews).where(eq(schema.artifactViews.artifactId, a.id));
    assert.ok(views.some((v) => v.email === 'sam@example.com' && v.path === '/' && v.status === 200), 'page view with who');
    assert.ok(views.some((v) => v.status === 302 && !v.userId), 'sign-in redirects of strangers');
    assert.ok(!views.some((v) => v.path === '/app.js'), 'assets are not views');
    const api = await db.select().from(schema.artifactApiLog).where(eq(schema.artifactApiLog.artifactId, a.id));
    assert.ok(api.some((l) => l.op === 'create' && l.target === 'tasks' && l.status === 201 && l.email === 'sam@example.com'), 'writes in full');
    assert.ok(api.some((l) => l.op === 'update' && l.status === 409), 'failed writes');
    assert.ok(api.some((l) => l.status === 403 && /cross-origin/.test(l.error)), 'refused cross-origin writes');
    assert.ok(!api.some((l) => l.method === 'GET' && l.status < 400), 'successful reads are not logged one by one');
    await logs.flushReads();
    const reads = await db.select().from(schema.artifactReadCounts).where(eq(schema.artifactReadCounts.artifactId, a.id));
    const taskReads = reads.filter((r) => r.target === 'tasks');
    assert.ok(taskReads.length >= 2, 'per person');
    assert.ok(taskReads.reduce((n, r) => n + r.count, 0) >= 3, 'reads counted per hour');
    const signins = (await db.select().from(schema.artifactSignins).where(eq(schema.artifactSignins.artifactId, a.id))).map((x) => x.result);
    for (const r of ['code_sent', 'code_ok', 'grant_ok', 'silent', 'code_no_access', 'code_wrong', 'grant_failed']) assert.ok(signins.includes(r), r);
  });

  await test('errors: from the page, grouped, and from failed calls', async () => {
    const rep = (body) => req('POST', '/_astrodock/api/_log', { host, origin, cookie: sam, json: body });
    const one = { kind: 'error', message: 'x is not defined', source: '/app.js:3:7', stack: 'ReferenceError…', path: '/' };
    assert.strictEqual((await rep({ reports: [one, one] })).status, 204);
    await rep({ reports: [one, { kind: 'rejection', message: 'boom' }] });
    await new Promise((r) => setTimeout(r, 150));
    const r = await req('GET', `/admin/artifacts/${id}/errors`, { token: readTok });
    const byMsg = Object.fromEntries(r.json.errors.map((e) => [e.message, e]));
    assert.strictEqual(byMsg['x is not defined'].count, 3);
    assert.deepStrictEqual(byMsg['x is not defined'].emails, ['sam@example.com']);
    assert.ok(byMsg.boom);
    assert.ok(r.json.errors.some((e) => e.kind === 'api' && /^409 update tasks/.test(e.message)), 'failed data calls are errors too');
    assert.strictEqual((await req('POST', '/_astrodock/api/_log', { host, cookie: sam, json: { reports: [one] } })).status, 403, 'own origin only');
    assert.strictEqual((await req('DELETE', `/admin/artifacts/${id}/errors`, { token: tok })).status, 204);
    assert.strictEqual((await req('GET', `/admin/artifacts/${id}/errors`, { token: tok })).json.errors.length, 0);
  });

  await test('history: before and after of every change, with who', async () => {
    const h = await req('GET', `/admin/artifacts/${id}/history?recordId=${taskId}`, { token: readTok });
    const acts = h.json.history.map((x) => [x.action, x.actor]);
    assert.deepStrictEqual(acts.at(-1), ['create', 'sam@example.com']);
    const upd = h.json.history.find((x) => x.action === 'update');
    assert.strictEqual(upd.actor, 'viv@example.com');
    assert.strictEqual(upd.before.done, true);
    assert.strictEqual(upd.after.done, false);
  });

  await test('usage: per artifact, and per person', async () => {
    const u = await req('GET', `/admin/artifacts/${id}/usage`, { token: readTok });
    assert.strictEqual(u.status, 200, u.body);
    assert.ok(u.json.usage.views30 >= 2);
    assert.ok(u.json.usage.people30 >= 2);
    assert.ok(u.json.usage.writes30 >= 4);
    assert.ok(u.json.usage.reads30 >= 3);
    assert.strictEqual(u.json.usage.records, 7, '4 tasks, 2 notes, 1 board post');
    assert.ok(u.json.usage.storageBytes > 0 && u.json.usage.fileBytes > 0);
    assert.ok(u.json.usage.emails30 >= 2);
    const sam0 = u.json.people.find((p) => p.email === 'sam@example.com');
    assert.strictEqual(sam0.role, 'staff');
    assert.ok(sam0.writes30 >= 3 && sam0.views30 >= 1 && sam0.lastSeen);
    assert.ok(u.json.people.some((p) => p.email === 'admin@example.com' && p.role === 'owner'));
    const list = await req('GET', '/admin/artifacts/usage', { token: tok });
    assert.strictEqual(list.json.artifacts[0].id, id);
    assert.strictEqual(list.json.artifacts[0].owner, 'admin@example.com');
    assert.ok(list.json.artifacts[0].usage.views30 >= 2);
  });

  await test('reports: broken ones to the owner, harmful ones to admins', async () => {
    const page = await req('GET', '/_astrodock/report', { host });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /Report a Problem/);
    const f = { host, origin };
    assert.strictEqual((await req('POST', '/_astrodock/report', { ...f, form: { kind: 'broken', message: 'Save does nothing' }, cookie: sam })).status, 200);
    assert.strictEqual((await req('POST', '/_astrodock/report', { ...f, form: { kind: 'abuse', message: 'Phishing form' } })).status, 200);
    assert.strictEqual((await req('POST', '/_astrodock/report', { host, form: { kind: 'abuse', message: 'x' } })).status, 403, 'own origin only');
    const own = await req('GET', `/admin/artifacts/${id}/reports`, { token: tok });
    assert.deepStrictEqual(own.json.reports.map((r) => [r.kind, r.email]), [['broken', 'sam@example.com']]);
    assert.strictEqual((await req('GET', '/admin/artifacts/reports', { token: tok })).status, 403, 'a key without artifacts:admin');
    const queue = await req('GET', '/admin/artifacts/reports', { token: adminJwt });
    assert.deepStrictEqual(queue.json.reports.map((r) => [r.kind, r.message, r.artifact.id]), [['abuse', 'Phishing form', id]]);
    const closed = await req('PATCH', `/admin/artifacts/reports/${queue.json.reports[0].id}`, { token: adminJwt, json: { status: 'closed' } });
    assert.strictEqual(closed.json.report.status, 'closed');
    const ev = await db.select().from(schema.events).where(eq(schema.events.type, 'artifact.reported'));
    assert.strictEqual(ev.length, 1, 'harmful reports raise an event for notification rules');
  });

  await test('retention: logs older than the window are deleted', async () => {
    const logs = require('../src/lib/artifacts/logs.js');
    await logs.prune(Date.now() + 91 * 864e5);
    for (const t of [schema.artifactViews, schema.artifactApiLog, schema.artifactReadCounts, schema.artifactSignins, schema.artifactRevisions]) {
      assert.strictEqual((await db.select().from(t)).length, 0);
    }
    assert.ok((await db.select().from(schema.artifactReports)).length > 0, 'reports are kept');
  });

  await test('owners see data; an operator\'s key sees only their own; admins moderate', async () => {
    const d = await req('GET', `/admin/artifacts/${id}/data/tasks`, { token: tok });
    assert.strictEqual(d.json.records.length, 4);
    // An operator (not an admin) with a key of their own.
    const ids = require('../src/lib/ids.js');
    const [op] = await db.insert(schema.users).values({ email: 'op@example.com', name: 'op', operatorRole: 'operator', isAdmin: true, appAccess: [] }).returning();
    const opTok = ids.generateApiToken();
    await db.insert(schema.apiTokens).values({ name: 'op', tokenHash: ids.hashToken(opTok), scopes: ['artifacts:read', 'artifacts:write'], authorizedByUserId: op.id });
    assert.strictEqual((await req('GET', `/admin/artifacts/${id}`, { token: opTok })).status, 404, 'not theirs');
    assert.deepStrictEqual((await req('GET', '/admin/artifacts', { token: opTok })).json.artifacts, []);
    assert.strictEqual((await req('PATCH', `/admin/artifacts/${id}`, { token: opTok, json: { title: 'mine now' } })).status, 404);
    // Shared with the operator: listed, still not manageable.
    await req('POST', `/admin/artifacts/${id}/shares`, { token: tok, json: { emails: ['op@example.com'], role: 'viewer', notify: false } });
    assert.deepStrictEqual((await req('GET', '/admin/artifacts', { token: opTok })).json.artifacts.map((a) => [a.id, a.access]), [[id, 'viewer']]);
    assert.strictEqual((await req('GET', `/admin/artifacts/${id}/data/tasks`, { token: opTok })).status, 404);
    // Their own, which the admin can take down.
    const mine = await req('POST', '/admin/artifacts', { token: opTok, json: { title: 'Op Board' } });
    assert.strictEqual(mine.status, 201);
    assert.strictEqual((await req('GET', '/admin/artifacts', { token: adminJwt })).json.artifacts.length, 1, 'the admin lists only their own by default');
    assert.strictEqual((await req('GET', '/admin/artifacts?all=1', { token: tok })).json.artifacts.length, 1, 'a key without artifacts:admin cannot list everyone\'s');
    assert.strictEqual((await req('GET', '/admin/artifacts?all=1', { token: adminJwt })).json.artifacts.length, 2);
    assert.strictEqual((await req('PATCH', `/admin/artifacts/${mine.json.artifact.id}`, { token: opTok, json: { suspended: true } })).status, 403);
    const down = await req('PATCH', `/admin/artifacts/${mine.json.artifact.id}`, { token: adminJwt, json: { suspended: true, suspendedReason: 'test' } });
    assert.strictEqual(down.json.artifact.suspended, true);
    assert.strictEqual((await req('GET', '/', { host: `${mine.json.artifact.id}.artifacts.localhost` })).status, 451);
  });

  await test('caddy asks: certificates only for artifacts that exist', async () => {
    assert.strictEqual((await req('GET', `/_caddy/ask?domain=${host}`)).status, 200);
    assert.strictEqual((await req('GET', '/_caddy/ask?domain=zzzzzzzzzzzz.artifacts.localhost')).status, 403);
  });

  await test('capability feedback is kept and sent upstream', async () => {
    const bad = await req('POST', '/admin/artifacts/feedback', { token: tok, json: { tried: 'x' } });
    assert.strictEqual(bad.status, 400);
    const r = await req('POST', '/admin/artifacts/feedback', { token: tok, json: { artifactId: id, needed: 'A rule comparing two fields', tried: 'field rules', workaround: 'filtered in the page' } });
    assert.strictEqual(r.status, 201, r.body);
    assert.strictEqual(r.json.feedback.upstreamStatus, 'sent');
    const rows = await db.select().from(schema.artifactFeedback);
    const up = rows.find((x) => x.source === 'upstream');
    assert.ok(up, 'received upstream');
    assert.strictEqual(up.needed, 'A rule comparing two fields');
    assert.ok(up.manifest && up.manifest.collections.tasks, 'with the manifest');
    assert.ok(!JSON.stringify(up).includes('example.com'), 'no email addresses upstream');
    assert.strictEqual((await req('POST', '/admin/artifacts/feedback', { token: readTok, json: { needed: 'x' } })).status, 403);
  });

  await test('hosted service: creators, their keys, plan limits, opening, suspension', async () => {
    const F = { token: 'fleet-test-token-0123456789' };
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators', { token: 'wrong', json: { email: 'c@example.com' } })).status, 401);
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators', { ...F, json: { email: 'admin@example.com' } })).status, 409, 'not an operator');
    const made = await req('POST', '/fleet/artifacts/creators', { ...F, json: { email: 'Cara@Example.com', name: 'Cara', plan: 'free' } });
    assert.strictEqual(made.status, 201, made.body);
    const ck = made.json.token;
    const [cara] = await db.select().from(schema.users).where(eq(schema.users.email, 'cara@example.com'));
    assert.strictEqual(cara.operatorRole, 'creator');
    // The key reaches artifacts and nothing else.
    assert.strictEqual((await req('GET', '/admin/apps', { token: ck })).status, 403);
    assert.strictEqual((await req('GET', '/admin/artifacts/reports', { token: ck })).status, 403);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await req('POST', '/admin/artifacts', { token: ck, json: { title: `C${i}` } });
      assert.strictEqual(r.status, 201, r.body);
      ids.push(r.json.artifact.id);
    }
    const fourth = await req('POST', '/admin/artifacts', { token: ck, json: { title: 'C4' } });
    assert.strictEqual(fourth.status, 403);
    assert.strictEqual(fourth.json.code, 'plan_limit');
    const pub = await req('PATCH', `/admin/artifacts/${ids[0]}`, { token: ck, json: { visibility: 'public' } });
    assert.deepStrictEqual([pub.status, pub.json.limit], [403, 'public']);
    const many = Array.from({ length: 11 }, (_, i) => `g${i}@example.com`);
    const over = await req('POST', `/admin/artifacts/${ids[0]}/shares`, { token: ck, json: { emails: many, notify: false } });
    assert.deepStrictEqual([over.status, over.json.limit], [403, 'guests']);
    // Upgrading lifts them.
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators/plan', { ...F, json: { email: 'cara@example.com', plan: 'creator' } })).status, 200);
    assert.strictEqual((await req('POST', '/admin/artifacts', { token: ck, json: { title: 'C4' } })).status, 201);
    assert.strictEqual((await req('PATCH', `/admin/artifacts/${ids[0]}`, { token: ck, json: { visibility: 'public' } })).status, 200);
    // A new key revokes the old one.
    const again = await req('POST', '/fleet/artifacts/creators', { ...F, json: { email: 'cara@example.com', plan: 'creator' } });
    assert.strictEqual((await req('GET', '/admin/artifacts', { token: ck })).status, 401);
    const ck2 = again.json.token;
    assert.strictEqual((await req('GET', '/admin/artifacts', { token: ck2 })).json.artifacts.length, 4);
    // Opening: a one-time grant for an artifact they can open, and nothing else.
    const open = await req('POST', '/fleet/artifacts/open', { ...F, json: { email: 'cara@example.com', artifactId: ids[1], next: '/x' } });
    assert.strictEqual(open.status, 200, open.body);
    const u = new URL(open.json.url);
    const cb = await req('GET', u.pathname + u.search, { host: u.host });
    assert.strictEqual(cb.headers.location, '/x');
    const me = await req('GET', '/_astrodock/api/me', { host: u.host, cookie: cookieFrom(cb) });
    assert.strictEqual(me.json.role, 'owner');
    assert.strictEqual((await req('POST', '/fleet/artifacts/open', { ...F, json: { email: 'sam@example.com', artifactId: ids[1] } })).status, 404, 'no access');
    // Suspending takes their artifacts down and stops new ones; restoring brings back only those.
    await req('PATCH', `/admin/artifacts/${ids[2]}`, { token: adminJwt, json: { suspended: true, suspendedReason: 'separate' } });
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators/suspend', { ...F, json: { email: 'cara@example.com', suspended: true } })).status, 200);
    assert.strictEqual((await req('GET', '/', { host: u.host })).status, 451);
    assert.strictEqual((await req('POST', '/admin/artifacts', { token: ck2, json: { title: 'C5' } })).status, 403);
    await req('POST', '/fleet/artifacts/creators/suspend', { ...F, json: { email: 'cara@example.com', suspended: false } });
    const after = await req('GET', '/admin/artifacts', { token: ck2 });
    assert.deepStrictEqual(after.json.artifacts.filter((a) => a.suspended).map((a) => a.id), [ids[2]], 'the separate take-down stays');
  });

  await test('hosted service: agent keys for a creator, listed and revoked on their own', async () => {
    const F = { token: 'fleet-test-token-0123456789' };
    const k = await req('POST', '/fleet/artifacts/creators/keys', { ...F, json: { email: 'cara@example.com', name: 'Claude Code' } });
    assert.strictEqual(k.status, 201, k.body);
    assert.strictEqual((await req('GET', '/admin/artifacts', { token: k.json.token })).status, 200);
    assert.strictEqual((await req('GET', '/admin/apps', { token: k.json.token })).status, 403, 'artifacts only');
    const list = await req('POST', '/fleet/artifacts/creators/keys/list', { ...F, json: { email: 'cara@example.com' } });
    assert.deepStrictEqual(list.json.keys.map((x) => x.name), ['Claude Code'], 'the service key is not listed');
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators/keys/revoke', { ...F, json: { email: 'sam@example.com', id: k.json.id } })).status, 404, 'only its owner');
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators/keys/revoke', { ...F, json: { email: 'cara@example.com', id: k.json.id } })).status, 200);
    assert.strictEqual((await req('GET', '/admin/artifacts', { token: k.json.token })).status, 401);
    assert.strictEqual((await req('POST', '/fleet/artifacts/creators/keys', { ...F, json: { email: 'admin@example.com' } })).status, 404, 'not for operators');
  });

  await test('hosted service: storage limit counts files and data', async () => {
    const F = { token: 'fleet-test-token-0123456789' };
    const dk = (await req('POST', '/fleet/artifacts/creators', { ...F, json: { email: 'dan@example.com', plan: 'free' } })).json.token;
    const saved = config.artifacts.plans.free.storageBytes;
    config.artifacts.plans.free.storageBytes = 300;
    try {
      const a = (await req('POST', '/admin/artifacts', { token: dk, json: { title: 'D', content: 'x'.repeat(200) } })).json.artifact;
      const over = await req('PUT', `/admin/artifacts/${a.id}/files`, { token: dk, json: { files: [{ name: 'b.txt', content: 'y'.repeat(200) }] } });
      assert.deepStrictEqual([over.status, over.json.limit], [403, 'storage']);
    } finally { config.artifacts.plans.free.storageBytes = saved; }
  });

  await test('deleting an artifact removes it and its data', async () => {
    assert.strictEqual((await req('DELETE', `/admin/artifacts/${id}`, { token: tok })).status, 204);
    assert.strictEqual((await req('GET', '/', { host })).status, 404);
    const left = await db.select().from(schema.artifactRecords);
    assert.strictEqual(left.length, 0);
  });
} finally {
  server.close();
  await close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
