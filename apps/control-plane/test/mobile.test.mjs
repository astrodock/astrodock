// The mobile app's server side, over real HTTP.
//
// Sign-in by PKCE, opening an app from a ticket, the inbox, the Notify API,
// and pushes to a fake relay running inside this process. As with launch, most
// of what follows is the refusals: a code that works twice, or a ticket that
// outlives someone's access, is a way in that nobody granted.
//
// Needs Postgres. Run: node test/mobile.test.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'mobile-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'mobile-test-key';
// The fake relay listens on 127.0.0.1, which net-guard otherwise refuses.
process.env.ASTRODOCK_WEBHOOK_ALLOW_PRIVATE = '1';

const { app: server } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const { setSetting } = require('../src/lib/settings.js');
const { hashPassword } = require('../src/lib/passwords.js');
const userSession = require('../src/lib/user-session.js');
const mobile = require('../src/lib/mobile.js');
const push = require('../src/lib/push.js');
const notifications = require('../src/lib/notifications.js');
const { eq, inArray } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate();

const EMAILS = ['ann@mobile.test', 'op@mobile.test', 'off@mobile.test', 'rate@mobile.test', 'pushy@mobile.test'];
const SLUGS = ['mobone', 'mobpub', 'mobtwo'];
const SETTING_KEYS = ['mobile.enabled', 'push.relay_url', 'push.server_id', 'push.server_secret'];

const cleanup = async () => {
  await db.delete(schema.apps).where(inArray(schema.apps.slug, SLUGS));
  await db.delete(schema.users).where(inArray(schema.users.email, EMAILS));
  await db.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, SETTING_KEYS));
};
await cleanup();

const mkApp = async (slug, extra = {}) => (await db.insert(schema.apps).values({
  slug, name: slug, subdomain: slug, port: 39700 + slug.length,
  appSecret: `s-${slug}`, appJwtSecret: `j-${slug}`, provisioned: true, ...extra
}).returning())[0];

const one = await mkApp('mobone');
await mkApp('mobpub', { authMode: 'public' });
await mkApp('mobtwo');

const PASSWORD = 'correct horse battery';
const [ann, op, off, rate, pushy] = await db.insert(schema.users).values([
  { email: 'ann@mobile.test', name: 'Ann', isActive: true, appAccess: ['mobone', 'mobpub'], passwordHash: await hashPassword(PASSWORD) },
  { email: 'op@mobile.test', name: 'Op', isActive: true, operatorRole: 'admin', appAccess: [] },
  { email: 'off@mobile.test', name: 'Off', isActive: false, appAccess: ['mobone'] },
  { email: 'rate@mobile.test', name: 'Rate', isActive: true, appAccess: ['mobone'] },
  { email: 'pushy@mobile.test', name: 'Pushy', isActive: true, appAccess: ['mobone'] }
]).returning();

// ── the fake relay ───────────────────────────────────────────────────────────
const relayLog = [];
const GOOD_HANDLE = `sub_${crypto.randomBytes(16).toString('hex')}`;
const GONE_HANDLE = `sub_${crypto.randomBytes(16).toString('hex')}`;
const relay = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/v1/servers') {
      if (body.registrationCode !== 'letmein') return send(403, { error: 'Wrong registration code.' });
      return send(200, { serverId: 'srv_testserver01', serverSecret: 'rss_testsecret0123456789' });
    }
    if (req.method === 'POST' && req.url === '/v1/push') {
      relayLog.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Bearer rss_testsecret0123456789') return send(401, { error: 'no' });
      if (body.handle === GONE_HANDLE) return send(404, { gone: true });
      return send(200, { ok: true });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;

const srv = server.listen(0);
await new Promise((r) => srv.once('listening', r));
const B = `http://127.0.0.1:${srv.address().port}`;

// ── helpers ──────────────────────────────────────────────────────────────────
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const sessionCookie = (u) => `${userSession.COOKIE}=${userSession.sign(u)}`;
const authorize = (challenge, { cookie, state = 'st-1', extra = {} } = {}) => fetch(`${B}/mobile/authorize?${new URLSearchParams({
  code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: 'astrodock://auth', ...extra
})}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const token = (body) => fetch(`${B}/mobile/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const DEVICE = { name: 'Test Phone', platform: 'ios', appVersion: '1.0.0' };
const codeFrom = (res) => new URL(res.headers.get('location')).searchParams.get('code');

async function signIn(user) {
  const { verifier, challenge } = pkce();
  const code = codeFrom(await authorize(challenge, { cookie: sessionCookie(user) }));
  const res = await token({ code, code_verifier: verifier, device: DEVICE });
  assert.strictEqual(res.status, 200, await res.clone().text());
  return res.json();
}
const api = (deviceToken, path, { method = 'GET', body } = {}) => fetch(`${B}${path}`, {
  method, redirect: 'manual',
  headers: { Authorization: `Bearer ${deviceToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});
const notify = (body) => fetch(`${B}/notify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: 'mobone', app_secret: 's-mobone', ...body })
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const deviceRow = async (id) => (await db.select().from(schema.mobileDevices).where(eq(schema.mobileDevices.id, id)))[0];

console.log('mobile');

try {
  await test('discovery answers any origin, with no relay yet', async () => {
    const res = await fetch(`${B}/.well-known/astrodock.json`, { headers: { Origin: 'https://elsewhere.test' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    const d = await res.json();
    assert.strictEqual(d.astrodock, 1);
    assert.strictEqual(d.name, 'Astrodock');
    assert.strictEqual(d.baseDomain, 'example.com');
    assert.strictEqual(d.authUrl, 'http://auth.example.com');
    assert.deepStrictEqual(d.mobile, { enabled: true });
    assert.strictEqual(d.push, null);
  });

  await test('authorize refuses another redirect and the plain method', async () => {
    const { challenge } = pkce();
    assert.strictEqual((await authorize(challenge, { extra: { redirect_uri: 'https://evil.test/cb' } })).status, 400);
    assert.strictEqual((await authorize(challenge, { extra: { code_challenge_method: 'plain' } })).status, 400);
    assert.strictEqual((await authorize('short')).status, 400);
  });

  await test('with no session, authorize shows the hosted sign-in form', async () => {
    const res = await authorize(pkce().challenge);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sign In to Astrodock/);
    assert.match(html, /"mobile":\{"codeChallenge"/);
  });

  let annDevice;
  await test('PKCE over HTTP: a session gives a code, the code and verifier give a device token', async () => {
    const { verifier, challenge } = pkce();
    const res = await authorize(challenge, { cookie: sessionCookie(ann), state: 'abc' });
    assert.strictEqual(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.strictEqual(`${loc.protocol}//${loc.host}`, 'astrodock://auth');
    assert.strictEqual(loc.searchParams.get('state'), 'abc');
    const tok = await token({ code: loc.searchParams.get('code'), code_verifier: verifier, device: DEVICE });
    assert.strictEqual(tok.status, 200, await tok.clone().text());
    annDevice = await tok.json();
    assert.match(annDevice.deviceToken, /^adt_[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual(annDevice.user, { id: ann.id, email: ann.email, name: 'Ann' });
    const row = await deviceRow(annDevice.deviceId);
    assert.notStrictEqual(row.tokenHash, annDevice.deviceToken, 'the token is stored hashed');
    assert.strictEqual(row.platform, 'ios');
  });

  await test('a code works once', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(challenge, { cookie: sessionCookie(ann) }));
    assert.strictEqual((await token({ code, code_verifier: verifier, device: DEVICE })).status, 200);
    const again = await token({ code, code_verifier: verifier, device: DEVICE });
    assert.strictEqual(again.status, 400);
  });

  await test('the wrong verifier is refused, and burns the code', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(challenge, { cookie: sessionCookie(ann) }));
    const wrong = await token({ code, code_verifier: pkce().verifier, device: DEVICE });
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual((await token({ code, code_verifier: verifier, device: DEVICE })).status, 400);
  });

  await test('an expired code is refused', async () => {
    const { verifier, challenge } = pkce();
    const code = await mobile.issueCode({ userId: ann.id, codeChallenge: challenge });
    await db.update(schema.mobileCodes).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mobileCodes.codeHash, crypto.createHash('sha256').update(code).digest('hex')));
    const res = await token({ code, code_verifier: verifier, device: DEVICE });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /expired/);
  });

  await test('a bad device is refused before the code is spent', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(challenge, { cookie: sessionCookie(ann) }));
    assert.strictEqual((await token({ code, code_verifier: verifier, device: { platform: 'web' } })).status, 400);
    assert.strictEqual((await token({ code, code_verifier: verifier, device: DEVICE })).status, 200);
  });

  await test('the sign-in form finishes a mobile sign-in through the same /login', async () => {
    const { verifier, challenge } = pkce();
    const res = await fetch(`${B}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: { codeChallenge: challenge, state: 'form' }, email: 'ann@mobile.test', password: PASSWORD })
    });
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.match(res.headers.get('set-cookie') || '', /ad_user_session=/);
    const loc = new URL((await res.json()).redirect);
    assert.strictEqual(loc.searchParams.get('state'), 'form');
    assert.strictEqual((await token({ code: loc.searchParams.get('code'), code_verifier: verifier, device: DEVICE })).status, 200);

    const bad = await fetch(`${B}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: { codeChallenge: challenge }, email: 'ann@mobile.test', password: 'wrong password' })
    });
    assert.strictEqual(bad.status, 401);
  });

  await test('an inactive account gets no code from its session', async () => {
    const res = await authorize(pkce().challenge, { cookie: sessionCookie(off) });
    assert.strictEqual(res.status, 200, 'should fall through to the form');
  });

  await test('the app list is the person\'s provisioned apps, by name, and no dashboard', async () => {
    const res = await api(annDevice.deviceToken, '/mobile/apps');
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.deepStrictEqual(d.apps.map((a) => a.slug), ['mobone', 'mobpub']);
    assert.strictEqual(d.apps[0].url, 'http://mobone.example.com');
    assert.strictEqual(d.apps[1].authMode, 'public');
    assert.strictEqual(d.admin, undefined);
    assert.strictEqual(d.user.email, 'ann@mobile.test');
  });

  await test('an operator also gets the dashboard', async () => {
    const d = await (await api((await signIn(op)).deviceToken, '/mobile/apps')).json();
    assert.deepStrictEqual(d.apps, []);
    assert.deepStrictEqual(d.admin, { url: 'http://admin.example.com' });
  });

  await test('the device record carries no hashes', async () => {
    const d = await (await api(annDevice.deviceToken, '/mobile/device')).json();
    assert.strictEqual(d.id, annDevice.deviceId);
    assert.strictEqual(d.tokenHash, undefined);
    assert.strictEqual(d.name, 'Test Phone');
  });

  const ticketFor = async (deviceToken, body) => {
    const res = await api(deviceToken, '/mobile/ticket', { method: 'POST', body });
    return { res, url: res.status === 200 ? (await res.json()).url : null };
  };
  const open = (url) => {
    const u = new URL(url);
    return fetch(`${B}${u.pathname}${u.search}`, { redirect: 'manual' });
  };

  await test('ticket → open sets the session and goes to the app\'s sign-in with next', async () => {
    const { res, url } = await ticketFor(annDevice.deviceToken, { app: 'mobone', path: '/tasks/12' });
    assert.strictEqual(res.status, 200);
    assert.match(url, /^http:\/\/auth\.example\.com\/mobile\/open\?ticket=amt_/);
    const opened = await open(url);
    assert.strictEqual(opened.status, 303);
    assert.strictEqual(opened.headers.get('location'), 'http://mobone.example.com/api/login?next=%2Ftasks%2F12');
    const cookie = (opened.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^ad_user_session=/);
    assert.strictEqual(userSession.read({ cookies: { ad_user_session: cookie.split('=')[1] } }).sub, ann.id);

    assert.strictEqual((await open(url)).status, 400, 'a ticket works once');
  });

  await test('a public app opens directly, at the path', async () => {
    const { url } = await ticketFor(annDevice.deviceToken, { app: 'mobpub', path: '/tasks/12' });
    const opened = await open(url);
    assert.strictEqual(opened.status, 303);
    assert.strictEqual(opened.headers.get('location'), 'http://mobpub.example.com/tasks/12');
  });

  await test('a path that leaves the app is refused', async () => {
    assert.strictEqual((await ticketFor(annDevice.deviceToken, { app: 'mobone', path: '//evil.test' })).res.status, 400);
    assert.strictEqual((await ticketFor(annDevice.deviceToken, { app: 'mobone', path: 'https://evil.test' })).res.status, 400);
  });

  await test('a ticket is refused without access, including access revoked after it was issued', async () => {
    assert.strictEqual((await ticketFor(annDevice.deviceToken, { app: 'mobtwo' })).res.status, 403);
    const { url } = await ticketFor(annDevice.deviceToken, { app: 'mobone' });
    await db.update(schema.users).set({ appAccess: ['mobpub'] }).where(eq(schema.users.id, ann.id));
    try {
      const opened = await open(url);
      assert.strictEqual(opened.status, 403);
      assert.ok(!(opened.headers.get('set-cookie') || '').includes('ad_user_session='));
    } finally {
      await db.update(schema.users).set({ appAccess: ['mobone', 'mobpub'] }).where(eq(schema.users.id, ann.id));
    }
  });

  await test('/notify checks the app secret, the person, and the input', async () => {
    assert.strictEqual((await notify({ app_secret: 'wrong', user_id: ann.id, title: 'x' })).status, 401);
    assert.strictEqual((await notify({ app_id: 'nosuchapp', user_id: ann.id, title: 'x' })).status, 400);
    assert.strictEqual((await notify({ user_id: op.id, title: 'x' })).status, 403, 'no access to the app');
    assert.strictEqual((await notify({ user_id: off.id, title: 'x' })).status, 403, 'inactive');
    assert.strictEqual((await notify({ email: 'nobody@mobile.test', title: 'x' })).status, 403, 'unknown');
    assert.strictEqual((await notify({ user_id: ann.id })).status, 400, 'no title');
    assert.strictEqual((await notify({ user_id: ann.id, title: 'x'.repeat(121) })).status, 400);
    assert.strictEqual((await notify({ user_id: ann.id, title: 'x', body: 'y'.repeat(1001) })).status, 400);
    assert.strictEqual((await notify({ user_id: ann.id, title: 'x', path: '//evil.test' })).status, 400);
  });

  let firstId;
  await test('/notify stores the notification, by id or by email', async () => {
    const a = await notify({ user_id: ann.id, title: 'Task Due', body: 'Call the bank', path: '/tasks/12' });
    assert.strictEqual(a.status, 200, await a.clone().text());
    firstId = (await a.json()).id;
    const b = await notify({ email: 'Ann@Mobile.test', title: 'Second' });
    assert.strictEqual(b.status, 200);
  });

  await test('the inbox lists newest first, with the app, and counts unread', async () => {
    const d = await (await api(annDevice.deviceToken, '/mobile/notifications')).json();
    assert.strictEqual(d.unread, 2);
    assert.deepStrictEqual(d.notifications.map((n) => n.title), ['Second', 'Task Due']);
    const first = d.notifications[1];
    assert.strictEqual(first.id, firstId);
    assert.deepStrictEqual(first.app, { slug: 'mobone', name: 'mobone' });
    assert.strictEqual(first.path, '/tasks/12');
    assert.strictEqual(first.readAt, null);
    const older = await (await api(annDevice.deviceToken, `/mobile/notifications?before=${encodeURIComponent(d.notifications[0].createdAt)}`)).json();
    assert.deepStrictEqual(older.notifications.map((n) => n.id), [firstId]);
  });

  await test('read and read-all', async () => {
    assert.strictEqual((await api(annDevice.deviceToken, `/mobile/notifications/${firstId}/read`, { method: 'POST' })).status, 200);
    assert.strictEqual((await (await api(annDevice.deviceToken, '/mobile/notifications')).json()).unread, 1);
    assert.strictEqual((await api(annDevice.deviceToken, '/mobile/notifications/read-all', { method: 'POST' })).status, 200);
    assert.strictEqual((await (await api(annDevice.deviceToken, '/mobile/notifications')).json()).unread, 0);
  });

  await test('someone else\'s notification cannot be marked read', async () => {
    const opDevice = await signIn(op);
    assert.strictEqual((await api(opDevice.deviceToken, `/mobile/notifications/${firstId}/read`, { method: 'POST' })).status, 404);
  });

  await test('/notify allows 60 per app per person per hour', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await notify({ user_id: rate.id, title: `n${i}` });
      assert.strictEqual(res.status, 200, `request ${i + 1}: ${res.status}`);
    }
    assert.strictEqual((await notify({ user_id: rate.id, title: 'one too many' })).status, 429);
    // Another person is a separate budget.
    assert.strictEqual((await notify({ user_id: ann.id, title: 'still fine' })).status, 200);
  });

  await test('registering with the relay needs its code, and stores the secret encrypted', async () => {
    await assert.rejects(push.register({ relayUrl: RELAY, registrationCode: 'nope', actor: 'test' }), /refused/);
    const r = await push.register({ relayUrl: RELAY, registrationCode: 'letmein', actor: 'test' });
    assert.deepStrictEqual(r, { relayUrl: RELAY, serverId: 'srv_testserver01' });
    const [row] = await db.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, 'push.server_secret'));
    assert.ok(String(row.value).startsWith('v1:'), 'stored in the clear');
    const d = await (await fetch(`${B}/.well-known/astrodock.json`)).json();
    assert.deepStrictEqual(d.push, { relayUrl: RELAY, serverId: 'srv_testserver01' });
  });

  const devicePair = crypto.generateKeyPairSync('x25519');
  const devicePub = push.rawPublic(devicePair.publicKey).toString('base64');

  await test('a device stores its handle and key, and refuses bad ones', async () => {
    assert.strictEqual((await api(annDevice.deviceToken, '/mobile/push', { method: 'PUT', body: { handle: 'nope', publicKey: devicePub, environment: 'sandbox' } })).status, 400);
    const res = await api(annDevice.deviceToken, '/mobile/push', { method: 'PUT', body: { handle: GOOD_HANDLE, publicKey: devicePub, environment: 'sandbox' } });
    assert.strictEqual(res.status, 200);
    const row = await deviceRow(annDevice.deviceId);
    assert.strictEqual(row.pushHandle, GOOD_HANDLE);
    assert.strictEqual(row.pushPublicKey, devicePub);
  });

  await test('/notify pushes an envelope only the device can read', async () => {
    relayLog.length = 0;
    const res = await notify({ user_id: ann.id, title: 'Pushed', body: 'Café at 3', path: '/x' });
    assert.strictEqual(res.status, 200);
    const { id } = await res.json();
    assert.ok(await until(() => relayLog.length > 0), 'the relay was never called');
    const sent = relayLog[0];
    assert.strictEqual(sent.auth, 'Bearer rss_testsecret0123456789');
    assert.strictEqual(sent.body.handle, GOOD_HANDLE);
    assert.strictEqual(typeof sent.body.badge, 'number');
    assert.ok(!JSON.stringify(sent.body).includes('Pushed'), 'the relay saw the title');
    const plain = JSON.parse(push.decrypt(sent.body.envelope, push.rawPrivate(devicePair.privateKey)));
    assert.deepStrictEqual(plain, { id, t: 'Pushed', b: 'Café at 3', a: 'mobone', an: 'mobone', p: '/x' });
  });

  await test('a handle the relay says is gone is cleared from the device', async () => {
    const d = await signIn(pushy);
    const key = push.rawPublic(crypto.generateKeyPairSync('x25519').publicKey).toString('base64');
    await api(d.deviceToken, '/mobile/push', { method: 'PUT', body: { handle: GONE_HANDLE, publicKey: key, environment: 'production' } });
    const res = await notify({ user_id: pushy.id, title: 'Anyone there?' });
    assert.strictEqual(res.status, 200, 'a push failure must not fail the request');
    assert.ok(await until(async () => (await deviceRow(d.deviceId)).pushHandle === null), 'push fields were not cleared');
    const row = await deviceRow(d.deviceId);
    assert.strictEqual(row.pushPublicKey, null);
    assert.strictEqual(row.pushEnvironment, null);
    assert.strictEqual(row.revokedAt, null, 'the device itself stays signed in');
  });

  await test('a push alert rule puts a platform notice in the inbox', async () => {
    const result = await notifications.sendTest({ channel: 'push', target: { users: [pushy.id] } });
    assert.strictEqual(result.status, 'sent');
    const rows = await db.select().from(schema.userNotifications).where(eq(schema.userNotifications.userId, pushy.id));
    const notice = rows.find((r) => r.appId === null);
    assert.ok(notice, 'no platform notice');
    assert.strictEqual(notice.path, null);
    assert.match(notice.body, /Test alert/);
    await assert.rejects(notifications.createRule({ channel: 'push', target: { users: ['not-a-uuid'] } }), /user ids/);
  });

  await test('notifications past 90 days are pruned with expired codes and tickets', async () => {
    const [old] = await db.insert(schema.userNotifications).values({
      userId: pushy.id, title: 'old', createdAt: new Date(Date.now() - 91 * 864e5)
    }).returning();
    await mobile.pruneExpired();
    assert.strictEqual((await db.select().from(schema.userNotifications).where(eq(schema.userNotifications.id, old.id))).length, 0);
    const [expired] = await db.select().from(schema.mobileCodes).limit(1);
    if (expired) assert.ok(new Date(expired.expiresAt) > new Date(), 'an expired code survived');
  });

  await test('a revoked device gets 401, and so do its tickets', async () => {
    const d = await signIn(ann);
    const { url } = await ticketFor(d.deviceToken, { app: 'mobone' });
    const out = await api(d.deviceToken, '/mobile/device', { method: 'DELETE' });
    assert.strictEqual(out.status, 200);
    const res = await api(d.deviceToken, '/mobile/apps');
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(await res.json(), { error: 'Sign in again.' });
    assert.strictEqual((await open(url)).status, 401);
    assert.strictEqual((await api('adt_nonsense', '/mobile/apps')).status, 401);
    assert.strictEqual((await fetch(`${B}/mobile/apps`)).status, 401);
  });

  await test('a deactivated person\'s device gets 401', async () => {
    const d = await signIn(rate);
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, rate.id));
    assert.strictEqual((await api(d.deviceToken, '/mobile/apps')).status, 401);
  });

  await test('with mobile off, every /mobile route is a 404', async () => {
    await setSetting('mobile.enabled', 'off', 'test');
    try {
      assert.strictEqual((await api(annDevice.deviceToken, '/mobile/apps')).status, 404);
      assert.strictEqual((await authorize(pkce().challenge)).status, 404);
      const d = await (await fetch(`${B}/.well-known/astrodock.json`)).json();
      assert.deepStrictEqual(d.mobile, { enabled: false });
    } finally {
      await setSetting('mobile.enabled', 'on', 'test');
    }
  });
} finally {
  srv.close();
  relay.close();
  await cleanup();
  await close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
