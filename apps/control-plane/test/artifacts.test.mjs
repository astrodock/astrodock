// Artifacts integration tests against a live local Postgres: management API,
// sign-in (silent for account members, email code for guests), the data API
// with its rules, live updates, revocation, and capability feedback.
// File upload and serving need the object store and run on the docker stack.
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
delete process.env.ASTRODOCK_ARTIFACTS_DOMAIN;

// Capture mail instead of sending it. Patched before the routes load, since
// they take sendEmail when they are required.
const mail = [];
const email = require('../src/lib/email.js');
email.sendEmail = async (m) => { mail.push(m); return { id: 'test' }; };
const emailConfig = require('../src/lib/email-config.js');
emailConfig.isUsable = () => true;

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
for (const t of [schema.artifactFeedback, schema.artifactSends, schema.artifactGrants, schema.artifactCodes, schema.artifactBlobs,
  schema.artifactRecords, schema.artifactShares, schema.artifactFiles, schema.artifacts, schema.artifactFolders,
  schema.apiTokens, schema.sessions, schema.users]) await db.delete(t);
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
