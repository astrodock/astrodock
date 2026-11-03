// Fixes from the November 2026 security review, end to end over real HTTP.
// Each test is a path that used to let someone go further than their role.
// Integration — needs a live Postgres. Run: node test/security-review.test.mjs
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'review-test-jwt';
process.env.ASTRODOCK_SECRET_KEY ||= '1'.repeat(64);
process.env.ASTRODOCK_TLS_MODE ||= 'off';
process.env.ASTRODOCK_RUNNER_TOKEN ||= 'review-runner-token';

const jwt = require('jsonwebtoken');
const { app } = require('../server.js');
const { migrate } = require('../src/db/migrate.js');
const { db, schema, close } = require('../src/db/index.js');
const { setSetting } = require('../src/lib/settings.js');
const userSession = require('../src/lib/user-session.js');
const { hashPassword } = require('../src/lib/passwords.js');
const { eq, inArray } = require('drizzle-orm');

await migrate();

let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ok  ' + n); p++; } catch (e) { console.error('  FAIL ' + n + '\n       ' + e.message); f++; } };
const A = (c, m) => { if (!c) throw new Error(m || 'failed'); };

const EMAILS = ['own@review.test', 'adm@review.test', 'target@review.test', 'end@review.test', 'made@review.test'];
const SLUGS = ['rv-one'];
async function cleanup() {
  await db.delete(schema.apps).where(inArray(schema.apps.slug, SLUGS));
  await db.delete(schema.users).where(inArray(schema.users.email, EMAILS));
  await db.delete(schema.platformSettings).where(inArray(schema.platformSettings.key,
    ['launch.issuer', 'launch.origin', 'launch.secret', 'security.agent_approvals']));
}
await cleanup();
// Another test file may leave an owner behind; this one wants to be the only one.
await db.update(schema.users).set({ operatorRole: 'admin' }).where(eq(schema.users.operatorRole, 'owner'));

const ph = await hashPassword('correct-horse-battery');
const [owner] = await db.insert(schema.users).values({ email: 'own@review.test', name: 'Own', passwordHash: ph, isActive: true, isAdmin: true, operatorRole: 'owner' }).returning();
await db.insert(schema.users).values({ email: 'adm@review.test', name: 'Adm', passwordHash: ph, isActive: true, isAdmin: true, operatorRole: 'admin' });
const [target] = await db.insert(schema.users).values({ email: 'target@review.test', name: 'Target', passwordHash: ph, isActive: true, isAdmin: true, operatorRole: 'viewer' }).returning();
const [endUser] = await db.insert(schema.users).values({ email: 'end@review.test', name: 'End', passwordHash: ph, isActive: true, appAccess: ['rv-one'] }).returning();
await db.insert(schema.apps).values({ slug: 'rv-one', name: 'rv-one', subdomain: 'rv-one', port: 39777, appSecret: 's', appJwtSecret: 'j', provisioned: true });

const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
const B = 'http://127.0.0.1:' + srv.address().port;
const J = async (m, u, b, tok, headers = {}) => {
  const r = await fetch(B + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined });
  const text = await r.text();
  let d = {}; try { d = JSON.parse(text); } catch { d = { text }; }
  return { s: r.status, d };
};
const login = async (email) => (await J('POST', '/admin/login', { email, password: 'correct-horse-battery' })).d.token;
// Age a session's confirmation past the window, as if signed in an hour ago.
const stale = async (token) => {
  const { sid } = jwt.decode(token);
  await db.update(schema.sessions).set({ reauthAt: new Date(Date.now() - 3600 * 1000) }).where(eq(schema.sessions.id, sid));
};

const OWN = await login('own@review.test');
const ADM = await login('adm@review.test');

console.log('backups');
await t('an admin cannot download, upload or restore a backup', async () => {
  for (const [m, u] of [['GET', '/admin/backups/x/file'], ['POST', '/admin/backups/upload'], ['POST', '/admin/backups/x/restore']]) {
    const r = await J(m, u, m === 'POST' ? {} : null, ADM);
    A(r.s === 403, `${m} ${u}: ${r.s} ${JSON.stringify(r.d)}`);
  }
});

console.log('\nconfirm before privilege changes');
await stale(OWN);
await t('changing a role with a stale session asks to confirm', async () => {
  const r = await J('PATCH', `/admin/users/${target.id}`, { operatorRole: 'admin' }, OWN);
  A(r.s === 403 && r.d.code === 'reauth_required', `${r.s} ${JSON.stringify(r.d)}`);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
  A(u.operatorRole === 'viewer', 'role unchanged');
});
await t('a refused change leaves the address alone too', async () => {
  const r = await J('PATCH', `/admin/users/${target.id}`, { operatorRole: 'admin', email: 'moved@review.test' }, OWN);
  A(r.s === 403, String(r.s));
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
  A(u.email === 'target@review.test', u.email);
});
await t('resetting a password with a stale session asks to confirm', async () => {
  const r = await J('POST', `/admin/users/${target.id}/reset-password`, { newPassword: 'another-password-1' }, OWN);
  A(r.s === 403 && r.d.code === 'reauth_required', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('creating a user with a stale session asks to confirm', async () => {
  const r = await J('POST', '/admin/users', { email: 'made@review.test', name: 'Made', password: 'a-password-123' }, OWN);
  A(r.s === 403 && r.d.code === 'reauth_required', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('turning approvals off with a stale session asks to confirm', async () => {
  const r = await J('PATCH', '/admin/settings', { updates: { 'security.agent_approvals': 'off' } }, OWN);
  A(r.s === 403 && r.d.code === 'reauth_required', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('isActive must be a boolean', async () => {
  const fresh = await login('own@review.test');
  const r = await J('PATCH', `/admin/users/${target.id}`, { isActive: 'false' }, fresh);
  A(r.s === 400, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a password reset signs the person out', async () => {
  const fresh = await login('own@review.test');
  const theirs = await login('target@review.test');
  A((await J('GET', '/admin/account', null, theirs)).s === 200, 'signed in before');
  const r = await J('POST', `/admin/users/${target.id}/reset-password`, { newPassword: 'another-password-1' }, fresh);
  A(r.s === 204, `${r.s} ${JSON.stringify(r.d)}`);
  A((await J('GET', '/admin/account', null, theirs)).s === 401, 'session ended');
});

console.log('\nkeys');
await t('a key limited to one app cannot create accounts', async () => {
  const fresh = await login('own@review.test');
  const key = (await J('POST', '/admin/tokens', { name: 'rv-agent', scopes: ['users:write', 'users:read'], apps: ['rv-one'] }, fresh)).d.token;
  A(key, 'key minted');
  const r = await J('POST', '/admin/users', { email: 'made@review.test', name: 'Made', password: 'a-password-123' }, key);
  A(r.s === 403, `${r.s} ${JSON.stringify(r.d)}`);
});

console.log('\napp sessions and operators');
const cookieFor = (u) => `${userSession.COOKIE}=${userSession.sign(u)}`;
await t('an operator\'s app session cannot attach a Google account', async () => {
  const r = await fetch(`${B}/account/google/link`, { redirect: 'manual', headers: { Cookie: cookieFor(owner) } });
  A(r.status === 403, String(r.status));
});
await t('an operator\'s app session cannot change its address without a password', async () => {
  const pk = (await db.insert(schema.users).values({ email: 'made@review.test', name: 'PK', isActive: true, isAdmin: true, operatorRole: 'viewer' }).returning())[0];
  const r = await fetch(`${B}/account/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieFor(pk), Origin: B, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ email: 'elsewhere@review.test' })
  });
  A(r.status === 403, String(r.status));
  await db.delete(schema.users).where(eq(schema.users.id, pk.id));
});

console.log('\nlaunch');
const SECRET = crypto.randomBytes(32).toString('hex');
await setSetting('launch.issuer', 'rv-launcher', 'test');
await setSetting('launch.origin', 'https://launcher.review', 'test');
await setSetting('launch.secret', SECRET, 'test');
const pass = (claims, opts = {}) => jwt.sign({ name: 'X', app: 'rv-one', jti: crypto.randomUUID(), ...claims }, SECRET,
  { algorithm: 'HS256', issuer: 'rv-launcher', audience: 'astrodock-launch', subject: 's', expiresIn: 60, ...opts });
const launch = (token) => fetch(`${B}/launch`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://launcher.review' },
  body: new URLSearchParams({ token }).toString()
});
await t('a launcher pass for an end user still works', async () => {
  const r = await launch(pass({ email: endUser.email }));
  A(r.status === 303, String(r.status));
});
await t('a launcher pass naming an operator is refused, with no session', async () => {
  const r = await launch(pass({ email: owner.email }));
  A(r.status === 403, String(r.status));
  A(!(r.headers.get('set-cookie') || '').includes(userSession.COOKIE), 'no cookie');
});
await t('a pass dated in the future is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ email: endUser.email, name: 'X', app: 'rv-one', jti: crypto.randomUUID(), iat: now + 86400, exp: now + 86400 + 60 },
    SECRET, { algorithm: 'HS256', issuer: 'rv-launcher', audience: 'astrodock-launch', subject: 's' });
  const r = await launch(token);
  A(r.status === 401, String(r.status));
});

await cleanup();
srv.close();
await close();
console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
