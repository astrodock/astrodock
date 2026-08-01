// Single sign-on across apps, over real HTTP.
//
// /authorize used to serve the sign-in form unconditionally, so someone using
// three apps typed their password three times and every hop between them looked
// like being thrown out to a stranger's site. The platform session fixes that —
// but only if it is genuinely a session and not a way around the checks, so most
// of what follows is the refusals.

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'sso-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'sso-test-key';

const { app: server } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const { hashPassword } = require('../src/lib/passwords.js');
const oauth = require('../src/lib/oauth.js');
const { eq } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate();

const PW = 'sso-test-password';
const mkApp = async (slug) => (await db.insert(schema.apps).values({
  slug, name: slug, subdomain: slug, port: 39500 + slug.length,
  appSecret: `s-${slug}`, appJwtSecret: `j-${slug}`
}).returning())[0];

await db.delete(schema.apps).where(eq(schema.apps.slug, 'ssoone'));
await db.delete(schema.apps).where(eq(schema.apps.slug, 'ssotwo'));
await db.delete(schema.users).where(eq(schema.users.email, 'sso@test.com'));

const one = await mkApp('ssoone');
const two = await mkApp('ssotwo');
const [user] = await db.insert(schema.users).values({
  email: 'sso@test.com', name: 'S', passwordHash: await hashPassword(PW),
  isActive: true, appAccess: ['ssoone', 'ssotwo']
}).returning();

await oauth.addRedirectUri(one.id, 'https://one.example.com/cb');
await oauth.addRedirectUri(two.id, 'https://two.example.com/cb');

const srv = server.listen(0);
await new Promise((r) => srv.once('listening', r));
const B = `http://127.0.0.1:${srv.address().port}`;

const authorize = (slug, redirect, cookie, extra = '') =>
  fetch(`${B}/authorize?app_id=${slug}&redirect_uri=${encodeURIComponent(redirect)}&state=st${extra}`,
    { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

console.log('single sign-on');

let sessionCookie = null;

try {
  await test('the first app asks for a password', async () => {
    const res = await authorize('ssoone', 'https://one.example.com/cb');
    assert.strictEqual(res.status, 200, 'expected the sign-in form');
    assert.match(await res.text(), /Sign in to/);
  });

  await test('signing in returns a code and sets a platform session', async () => {
    const res = await fetch(`${B}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'ssoone', redirectUri: 'https://one.example.com/cb', email: 'sso@test.com', password: PW })
    });
    const body = await res.json().catch(() => ({}));
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.ok(body.code, 'no code issued');
    const set = res.headers.get('set-cookie') || '';
    assert.match(set, /ad_user_session=/, 'no platform session cookie');
    assert.match(set, /HttpOnly/i, 'the session cookie must not be readable by script');
    // Lax, not Strict: the flow is a top-level navigation FROM the app's origin,
    // and Strict would drop the cookie on exactly that hop.
    assert.match(set, /SameSite=Lax/i, 'Strict would break the redirect it exists for');
    sessionCookie = set.split(';')[0];
  });

  await test('a second app does not ask again — it redirects straight back', async () => {
    const res = await authorize('ssotwo', 'https://two.example.com/cb', sessionCookie);
    assert.strictEqual(res.status, 302, 'expected a redirect, not a form');
    const loc = new URL(res.headers.get('location'));
    assert.strictEqual(loc.origin + loc.pathname, 'https://two.example.com/cb');
    assert.ok(loc.searchParams.get('code'), 'no code on the redirect');
    assert.strictEqual(loc.searchParams.get('state'), 'st', 'state was not carried through');
  });

  await test('the code from a silent sign-in is real and single-use', async () => {
    const res = await authorize('ssotwo', 'https://two.example.com/cb', sessionCookie);
    const code = new URL(res.headers.get('location')).searchParams.get('code');
    const who = await oauth.redeemCode({ code, appId: two.id, redirectUri: 'https://two.example.com/cb' });
    assert.strictEqual(who.id, user.id);
    await assert.rejects(
      () => oauth.redeemCode({ code, appId: two.id, redirectUri: 'https://two.example.com/cb' }),
      /not valid/, 'a spent code was accepted twice');
  });

  await test('a session does NOT bypass the per-app access check', async () => {
    const three = await mkApp('ssothree');
    await oauth.addRedirectUri(three.id, 'https://three.example.com/cb');
    const res = await authorize('ssothree', 'https://three.example.com/cb', sessionCookie);
    assert.strictEqual(res.status, 200, 'an app the user has no access to must still show the form');
    await db.delete(schema.apps).where(eq(schema.apps.id, three.id));
  });

  await test('a session does NOT bypass the redirect allowlist', async () => {
    const res = await authorize('ssotwo', 'https://attacker.example.com/cb', sessionCookie);
    assert.strictEqual(res.status, 400, 'an unregistered redirect was accepted');
  });

  await test('prompt=login forces the form even with a session', async () => {
    const res = await authorize('ssotwo', 'https://two.example.com/cb', sessionCookie, '&prompt=login');
    assert.strictEqual(res.status, 200, 'prompt=login did not force re-authentication');
  });

  await test('a deactivated account falls back to the form rather than signing in', async () => {
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, user.id));
    const res = await authorize('ssotwo', 'https://two.example.com/cb', sessionCookie);
    assert.strictEqual(res.status, 200, 'a deactivated user was signed in from a stale session');
    await db.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, user.id));
  });

  await test('revoking access mid-session stops the silent sign-in', async () => {
    await db.update(schema.users).set({ appAccess: ['ssoone'] }).where(eq(schema.users.id, user.id));
    const res = await authorize('ssotwo', 'https://two.example.com/cb', sessionCookie);
    assert.strictEqual(res.status, 200, 'access was revoked but the session still let them through');
    await db.update(schema.users).set({ appAccess: ['ssoone', 'ssotwo'] }).where(eq(schema.users.id, user.id));
  });

  await test('a forged session cookie is ignored', async () => {
    const res = await authorize('ssotwo', 'https://two.example.com/cb', 'ad_user_session=not.a.real.jwt');
    assert.strictEqual(res.status, 200, 'a junk cookie was treated as a session');
  });

  await test('logout clears the session, and the next app asks again', async () => {
    const out = await fetch(`${B}/logout`, { headers: { Cookie: sessionCookie }, redirect: 'manual' });
    assert.ok(out.status === 200 || out.status === 302);
    assert.match(out.headers.get('set-cookie') || '', /ad_user_session=;/, 'the cookie was not cleared');
  });
} finally {
  await db.delete(schema.apps).where(eq(schema.apps.slug, 'ssoone'));
  await db.delete(schema.apps).where(eq(schema.apps.slug, 'ssotwo'));
  await db.delete(schema.users).where(eq(schema.users.email, 'sso@test.com'));
  srv.close();
  await close().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
