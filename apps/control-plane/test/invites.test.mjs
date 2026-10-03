// Inviting an end user, over the real database.
//
// The invariant worth protecting: an invited account exists, can be found by
// email, and can do nothing at all until the invite is redeemed. It is held by
// having no credential and no app access rather than by is_active, because a
// disabled account is refused by Google sign-in before it can be linked — which
// would block the one thing the invite is for.
//
// Needs Postgres. Run: node test/invites.test.mjs

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'invite-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'invite-test-key';

const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const invites = require('../src/lib/invites.js');
const factors = require('../src/lib/auth-factors.js');
const { eq } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); failed++; }
}

await migrate();

console.log('invites');

const SLUG = 'invtest';
await db.delete(schema.apps).where(eq(schema.apps.slug, SLUG));
const [app] = await db.insert(schema.apps).values({
  slug: SLUG, name: 'Invite Test', subdomain: SLUG, port: 39777,
  appSecret: 's-inv', appJwtSecret: 'j-inv'
}).returning();

const addr = (n) => `inv-${n}-${Date.now()}@example.com`;
const freshUser = async (email) => (await db.select().from(schema.users)
  .where(eq(schema.users.email, email)).limit(1))[0];

await test('an invited account starts with no credential and no access', async () => {
  const email = addr('plain');
  const r = await invites.create({ email, name: 'Ann', app, invitedByName: 'Paul' });
  assert.equal(r.existingUser, false);
  const u = await freshUser(email);
  assert.equal(u.passwordHash, null, 'a password was set for them');
  assert.deepEqual(u.appAccess, [], 'access was granted before redemption');
  assert.equal(u.operatorRole, null, 'an invite produced an operator');
  // Active, deliberately: a disabled account cannot link a Google identity.
  assert.equal(u.isActive, true);
  assert.ok(r.token && r.url.endsWith(`/invite/${r.token}`));
});

await test('the token is not recoverable from the row that stores it', async () => {
  const email = addr('hash');
  const { token, invite } = await invites.create({ email, name: 'H', app });
  const [row] = await db.select().from(schema.userInvites)
    .where(eq(schema.userInvites.id, invite.id)).limit(1);
  assert.notEqual(row.tokenHash, token);
  assert.equal(row.tokenHash, invites.hashToken(token));
});

await test('redeeming grants access to that app and nothing else', async () => {
  const email = addr('redeem');
  const { token } = await invites.create({ email, name: 'R', app });
  const { invite, user } = await invites.resolve(token);
  await factors.setPassword(user.id, 'a-long-enough-password');
  const signedIn = await invites.redeem({ invite, userId: user.id });
  assert.deepEqual(signedIn.appAccess, [SLUG]);
  const u = await freshUser(email);
  assert.deepEqual(u.appAccess, [SLUG]);
  assert.ok(u.passwordHash, 'the password did not stick');
});

await test('an invite is single use', async () => {
  const email = addr('once');
  const { token } = await invites.create({ email, name: 'O', app });
  const first = await invites.resolve(token);
  await invites.redeem({ invite: first.invite, userId: first.user.id });
  const second = await invites.resolve(token);
  assert.match(second.error, /already been used/);
});

await test('two tabs cannot both redeem the same invite', async () => {
  const email = addr('race');
  const { token } = await invites.create({ email, name: 'Z', app });
  const { invite, user } = await invites.resolve(token);
  const results = await Promise.allSettled([
    invites.redeem({ invite, userId: user.id }),
    invites.redeem({ invite, userId: user.id })
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1, 'both redemptions succeeded');
});

await test('an expired invite is refused', async () => {
  const email = addr('expired');
  const { token, invite } = await invites.create({ email, name: 'E', app });
  await db.update(schema.userInvites)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.userInvites.id, invite.id));
  const r = await invites.resolve(token);
  assert.match(r.error, /expired/);
});

await test('resending supersedes the invite it replaces', async () => {
  const email = addr('resend');
  const first = await invites.create({ email, name: 'S', app });
  const second = await invites.create({ email, name: 'S', app });
  assert.equal(second.existingUser, true, 'the second invite made a second account');
  assert.match((await invites.resolve(first.token)).error, /already been used/);
  assert.ok((await invites.resolve(second.token)).invite, 'the live invite was not usable');
});

await test('inviting an existing account reuses it', async () => {
  const email = addr('existing');
  await invites.create({ email, name: 'X', app });
  const again = await invites.create({ email, name: 'X', app });
  assert.equal(again.existingUser, true);
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email));
  assert.equal(rows.length, 1, 'a duplicate account was created');
});

await test('a return address on a foreign host is refused', async () => {
  await assert.rejects(
    () => invites.create({ email: addr('evil'), name: 'V', app, redirectTo: 'https://evil.test/steal' }),
    /not one of this app's hostnames/
  );
  // The app's own hostname is fine.
  const r = await invites.create({
    email: addr('good'), name: 'G', app, redirectTo: `http://${SLUG}.example.com/invite/abc`
  });
  assert.ok(r.token);
});

await test('with no return address the app front door is used', async () => {
  const email = addr('landing');
  const { token } = await invites.create({ email, name: 'L', app });
  const { invite } = await invites.resolve(token);
  assert.equal(await invites.landingUrl(invite, app), `http://${SLUG}.example.com/`);
});

await test('a placeholder is only discarded while nothing has touched it', async () => {
  const email = addr('placeholder');
  await invites.create({ email, name: 'P', app });
  const u = await freshUser(email);
  assert.equal(await invites.discardPlaceholder(u.id), true);
  assert.equal(await freshUser(email), undefined);

  // One that has signed in is not a placeholder, whatever the caller thinks.
  const email2 = addr('real');
  await invites.create({ email: email2, name: 'Q', app });
  const u2 = await freshUser(email2);
  await factors.setPassword(u2.id, 'another-long-password');
  assert.equal(await invites.discardPlaceholder(u2.id), false);
  assert.ok(await freshUser(email2), 'an account with a password was deleted');
});

await db.delete(schema.apps).where(eq(schema.apps.slug, SLUG));
await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
