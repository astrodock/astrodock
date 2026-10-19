// Signing in from a trusted launcher, over real HTTP.
//
// The launcher signs a pass, the browser posts it to /launch, and the person
// lands in the app already signed in. Most of what follows is the refusals:
// a pass that can be replayed, posted from elsewhere, or kept for a week would
// be a password that never expires.
//
// Needs Postgres. Run: node test/launch.test.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'launch-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'launch-test-key';

const jwt = require('jsonwebtoken');
const { app: server } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const { setSetting } = require('../src/lib/settings.js');
const oauth = require('../src/lib/oauth.js');
const { eq, inArray } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate();

const ISSUER = 'test-launcher';
const ORIGIN = 'https://launcher.test';
const SECRET = crypto.randomBytes(32).toString('hex');
const EMAILS = ['new@launch.test', 'existing@launch.test', 'disabled@launch.test'];
const SLUGS = ['launchone', 'launchtwo', 'launchpub', 'launchraw'];

await db.delete(schema.apps).where(inArray(schema.apps.slug, SLUGS));
await db.delete(schema.users).where(inArray(schema.users.email, EMAILS));
await db.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, ['launch.issuer', 'launch.origin', 'launch.secret']));

const mkApp = async (slug, extra = {}) => (await db.insert(schema.apps).values({
  slug, name: slug, subdomain: slug, port: 39600 + slug.length,
  appSecret: `s-${slug}`, appJwtSecret: `j-${slug}`, provisioned: true, ...extra
}).returning())[0];

const one = await mkApp('launchone');
await mkApp('launchtwo', { authLoginPath: '/auth/start' });
await mkApp('launchpub', { authMode: 'public' });
await mkApp('launchraw', { provisioned: false });
await oauth.addRedirectUri(one.id, 'https://launchone.example.com/api/auth/callback');

await db.insert(schema.users).values([
  { email: 'existing@launch.test', name: 'Existing', isActive: true, appAccess: ['launchtwo'] },
  { email: 'disabled@launch.test', name: 'Disabled', isActive: false, appAccess: ['launchone'] }
]);

const srv = server.listen(0);
await new Promise((r) => srv.once('listening', r));
const B = `http://127.0.0.1:${srv.address().port}`;

const pass = (claims = {}, { secret = SECRET, expiresIn = 60 } = {}) => jwt.sign({
  email: 'new@launch.test', name: 'New Person', app: 'launchone', jti: crypto.randomUUID(), ...claims
}, secret, { algorithm: 'HS256', issuer: ISSUER, audience: 'astrodock-launch', subject: 'u-1', expiresIn });

const post = (token, { origin = ORIGIN } = {}) => fetch(`${B}/launch`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) },
  body: new URLSearchParams({ token }).toString()
});

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const user = async (email) => (await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];

console.log('launch');

try {
  await test('is off until a launcher is configured', async () => {
    const res = await post(pass());
    assert.strictEqual(res.status, 404);
  });

  await setSetting('launch.issuer', ISSUER, 'test');
  await setSetting('launch.origin', ORIGIN, 'test');
  await setSetting('launch.secret', SECRET, 'test');

  await test('the shared secret is stored encrypted', async () => {
    const [row] = await db.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, 'launch.secret'));
    assert.ok(String(row.value).startsWith('v1:'), 'stored in the clear');
  });

  await test('a short secret is refused', async () => {
    await assert.rejects(setSetting('launch.secret', 'short', 'test'), /at least 32/);
  });

  let session = '';
  await test('a new person is created, given the app, signed in, and sent to its sign-in', async () => {
    const res = await post(pass());
    assert.strictEqual(res.status, 303, await res.text());
    assert.strictEqual(res.headers.get('location'), 'http://launchone.example.com/api/login');
    session = cookieOf(res);
    assert.match(session, /^ad_user_session=/);
    const u = await user('new@launch.test');
    assert.deepStrictEqual(u.appAccess, ['launchone']);
    assert.strictEqual(u.name, 'New Person');
    assert.strictEqual(u.operatorRole, null);
    assert.strictEqual(u.passwordHash, null);
  });

  await test('the app\'s own sign-in then completes without a form', async () => {
    const redirect = 'https://launchone.example.com/api/auth/callback';
    const res = await fetch(`${B}/authorize?app_id=launchone&redirect_uri=${encodeURIComponent(redirect)}&state=s1`,
      { redirect: 'manual', headers: { Cookie: session } });
    assert.strictEqual(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.strictEqual(loc.origin + loc.pathname, redirect);
    assert.ok(loc.searchParams.get('code'));
  });

  await test('a pass works once', async () => {
    const t = pass();
    assert.strictEqual((await post(t)).status, 303);
    const again = await post(t);
    assert.strictEqual(again.status, 401);
    assert.match(await again.text(), /already used/);
  });

  await test('a pass posted from another page is refused', async () => {
    assert.strictEqual((await post(pass(), { origin: 'https://evil.test' })).status, 403);
    assert.strictEqual((await post(pass(), { origin: '' })).status, 403);
  });

  await test('a pass signed with another secret is refused', async () => {
    assert.strictEqual((await post(pass({}, { secret: crypto.randomBytes(32).toString('hex') }))).status, 401);
  });

  await test('a pass for another audience or issuer is refused', async () => {
    const wrongAud = jwt.sign({ email: 'new@launch.test', app: 'launchone', jti: crypto.randomUUID() }, SECRET,
      { algorithm: 'HS256', issuer: ISSUER, audience: 'something-else', expiresIn: 60 });
    const wrongIss = jwt.sign({ email: 'new@launch.test', app: 'launchone', jti: crypto.randomUUID() }, SECRET,
      { algorithm: 'HS256', issuer: 'someone-else', audience: 'astrodock-launch', expiresIn: 60 });
    assert.strictEqual((await post(wrongAud)).status, 401);
    assert.strictEqual((await post(wrongIss)).status, 401);
  });

  await test('a long-lived pass is refused, and so is an expired one', async () => {
    assert.strictEqual((await post(pass({}, { expiresIn: 3600 }))).status, 401);
    const expired = jwt.sign({ email: 'new@launch.test', app: 'launchone', jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 }, SECRET,
      { algorithm: 'HS256', issuer: ISSUER, audience: 'astrodock-launch' });
    const res = await post(expired);
    assert.strictEqual(res.status, 401);
    assert.match(await res.text(), /expired/);
  });

  await test('a pass with no id is refused', async () => {
    const noJti = jwt.sign({ email: 'new@launch.test', app: 'launchone' }, SECRET,
      { algorithm: 'HS256', issuer: ISSUER, audience: 'astrodock-launch', expiresIn: 60 });
    assert.strictEqual((await post(noJti)).status, 401);
  });

  await test('an existing person keeps their access and gains the new app', async () => {
    const res = await post(pass({ email: 'Existing@Launch.test' }));
    assert.strictEqual(res.status, 303);
    assert.deepStrictEqual((await user('existing@launch.test')).appAccess.sort(), ['launchone', 'launchtwo']);
  });

  await test('a disabled account stays out', async () => {
    const res = await post(pass({ email: 'disabled@launch.test' }));
    assert.strictEqual(res.status, 403);
    assert.ok(!cookieOf(res).startsWith('ad_user_session='));
  });

  await test('the app\'s declared sign-in path is used', async () => {
    const res = await post(pass({ app: 'launchtwo' }));
    assert.strictEqual(res.headers.get('location'), 'http://launchtwo.example.com/auth/start');
  });

  await test('a public app is opened directly', async () => {
    const res = await post(pass({ app: 'launchpub' }));
    assert.strictEqual(res.status, 303);
    assert.strictEqual(res.headers.get('location'), 'http://launchpub.example.com');
  });

  await test('unknown and unprovisioned apps are refused', async () => {
    assert.strictEqual((await post(pass({ app: 'nosuchapp' }))).status, 404);
    assert.strictEqual((await post(pass({ app: 'launchraw' }))).status, 409);
  });
} finally {
  srv.close();
  await db.delete(schema.apps).where(inArray(schema.apps.slug, SLUGS));
  await db.delete(schema.users).where(inArray(schema.users.email, EMAILS));
  await db.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, ['launch.issuer', 'launch.origin', 'launch.secret']));
  await close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
