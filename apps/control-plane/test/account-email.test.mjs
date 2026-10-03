// Changing the address an account signs in with, and attaching a Google account
// to one that already exists.
//
// Both exist because neither was possible. The admin PATCH ignored email, the
// admin panel rendered the field disabled, and the hosted account page only did
// passwords — so an address typed into an invite was permanent. And
// resolveEndUser can only attach a Google identity whose verified address
// already matches the account, so somebody invited at a work address who uses a
// different Google account had no route in at all.
//
// The asymmetry is the thing to protect: an operator sets an address directly,
// a person proves the new one. Without the proof, someone could park their
// account on a colleague's address and the next invite sent to that colleague
// would find the account already holding it.
//
// Needs Postgres. Run: node test/account-email.test.mjs

import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'acct-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= 'acct-test-key';

const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const accountEmail = require('../src/lib/account-email.js');
const googleAccounts = require('../src/lib/google-accounts.js');
const { hashPassword } = require('../src/lib/passwords.js');
const { eq } = require('drizzle-orm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); failed++; }
}

await migrate();
console.log('account self-service');

const stamp = Date.now();
const addr = (n) => `acct-${n}-${stamp}@example.com`;
const mkUser = async (email, { password = 'a-long-enough-password', googleSub = null } = {}) =>
  (await db.insert(schema.users).values({
    email, name: email.split('@')[0],
    passwordHash: password ? await hashPassword(password) : null,
    googleSub, appAccess: []
  }).returning())[0];
const fresh = async (id) => (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];

// ── operator change ──────────────────────────────────────────────────────────

await test('an operator sets the address directly', async () => {
  const u = await mkUser(addr('op'));
  const next = addr('op-new');
  await accountEmail.setByOperator({ userId: u.id, newEmail: next, actor: 'paul' });
  assert.equal((await fresh(u.id)).email, next);
});

await test('the address is normalized, so case cannot create a second account', async () => {
  const u = await mkUser(addr('case'));
  const next = `MiXeD-${stamp}@Example.COM`;
  await accountEmail.setByOperator({ userId: u.id, newEmail: next, actor: 'paul' });
  assert.equal((await fresh(u.id)).email, next.toLowerCase());
});

await test('an address another account already uses is refused', async () => {
  const a = await mkUser(addr('taken-a'));
  const b = await mkUser(addr('taken-b'));
  await assert.rejects(
    () => accountEmail.setByOperator({ userId: b.id, newEmail: a.email, actor: 'paul' }),
    /already uses that address/
  );
  assert.notEqual((await fresh(b.id)).email, a.email);
});

await test('nonsense is refused before it reaches the column', async () => {
  const u = await mkUser(addr('bad'));
  await assert.rejects(
    () => accountEmail.setByOperator({ userId: u.id, newEmail: 'not an address', actor: 'paul' }),
    /does not look like an email address/
  );
});

// ── self-service change ──────────────────────────────────────────────────────

await test('a self-service request changes nothing on its own', async () => {
  const u = await mkUser(addr('self'));
  const want = addr('self-new');
  let row;
  try {
    row = await accountEmail.request({ user: u, newEmail: want });
  } catch (err) {
    // No mail provider on a bare test box, which is itself the right behavior:
    // the refusal is loud rather than a silent non-delivery.
    assert.match(err.message, /cannot send email/);
    return;
  }
  assert.equal((await fresh(u.id)).email, u.email, 'the address changed before confirmation');
  assert.equal(row.newEmail, want);
  assert.equal(row.confirmedAt, null);
});

await test('confirming applies it, and only once', async () => {
  // Built directly rather than through request(), so the test does not depend on
  // a mail provider being configured.
  const u = await mkUser(addr('confirm'));
  const want = addr('confirm-new');
  const token = 'tok-confirm-' + stamp;
  await db.insert(schema.emailChanges).values({
    userId: u.id, newEmail: want, tokenHash: accountEmail.hashToken(token),
    expiresAt: new Date(Date.now() + 36e5)
  });
  const r = await accountEmail.confirm(token);
  assert.equal(r.to, want);
  assert.equal((await fresh(u.id)).email, want);
  await assert.rejects(() => accountEmail.confirm(token), /already been used/);
});

await test('an expired link is refused', async () => {
  const u = await mkUser(addr('expired'));
  const token = 'tok-expired-' + stamp;
  await db.insert(schema.emailChanges).values({
    userId: u.id, newEmail: addr('expired-new'), tokenHash: accountEmail.hashToken(token),
    expiresAt: new Date(Date.now() - 1000)
  });
  await assert.rejects(() => accountEmail.confirm(token), /expired/);
  assert.equal((await fresh(u.id)).email, u.email);
});

await test('an address taken while the link sat in an inbox is refused at confirm', async () => {
  // Checked twice on purpose: free when requested is not free an hour later.
  const u = await mkUser(addr('race'));
  const rival = await mkUser(addr('race-rival'));
  const token = 'tok-race-' + stamp;
  await db.insert(schema.emailChanges).values({
    userId: u.id, newEmail: rival.email, tokenHash: accountEmail.hashToken(token),
    expiresAt: new Date(Date.now() + 36e5)
  });
  await assert.rejects(() => accountEmail.confirm(token), /already uses that address/);
  assert.equal((await fresh(u.id)).email, u.email);
});

await test('a bogus token says so rather than throwing something internal', async () => {
  await assert.rejects(() => accountEmail.confirm('nope'), /not valid/);
  await assert.rejects(() => accountEmail.confirm(''), /incomplete/);
});

// ── attaching Google ─────────────────────────────────────────────────────────

const identity = (sub, email, verified = true) => ({ sub, email, emailVerified: verified, name: 'X' });

await test('a Google account attaches even when the address differs', async () => {
  // The entire reason linkToUser exists. resolveEndUser cannot do this.
  const u = await mkUser(addr('link'));
  const r = await googleAccounts.linkToUser({
    userId: u.id, identity: identity(`sub-link-${stamp}`, 'something-else@gmail.com')
  });
  assert.equal(r.googleSub, `sub-link-${stamp}`);
  assert.equal((await fresh(u.id)).googleSub, `sub-link-${stamp}`);
});

await test('a Google account already on another account is refused', async () => {
  const sub = `sub-shared-${stamp}`;
  const a = await mkUser(addr('shared-a'), { googleSub: sub });
  const b = await mkUser(addr('shared-b'));
  await assert.rejects(
    () => googleAccounts.linkToUser({ userId: b.id, identity: identity(sub, 'x@gmail.com') }),
    /already attached to a different account/
  );
  assert.equal((await fresh(b.id)).googleSub, null);
});

await test('swapping one Google account for another needs the first removed', async () => {
  const u = await mkUser(addr('swap'), { googleSub: `sub-first-${stamp}` });
  await assert.rejects(
    () => googleAccounts.linkToUser({ userId: u.id, identity: identity(`sub-second-${stamp}`, 'y@gmail.com') }),
    /already uses a different Google account/
  );
});

await test('detaching leaves the account reachable, or is refused', async () => {
  const withPw = await mkUser(addr('unlink-pw'), { googleSub: `sub-pw-${stamp}` });
  await googleAccounts.unlinkFromUser(withPw.id);
  assert.equal((await fresh(withPw.id)).googleSub, null);

  // Google only: detaching would lock them out of their own account.
  const only = await mkUser(addr('unlink-only'), { password: null, googleSub: `sub-only-${stamp}` });
  await assert.rejects(() => googleAccounts.unlinkFromUser(only.id), /only way into this account/);
  assert.equal((await fresh(only.id)).googleSub, `sub-only-${stamp}`);
});

await test('a disabled account cannot have anything attached to it', async () => {
  const u = await mkUser(addr('disabled'));
  await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, u.id));
  await assert.rejects(
    () => googleAccounts.linkToUser({ userId: u.id, identity: identity(`sub-dis-${stamp}`, 'z@gmail.com') }),
    /disabled/
  );
});

await db.delete(schema.users).where(eq(schema.users.name, 'acct-op'));
await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
