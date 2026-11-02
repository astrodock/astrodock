// Hosted mode, end to end over real HTTP: approvals for what a key does beyond
// one app, `astrodock login` sessions, the fleet API, and per-app caps.
// Integration — needs a live Postgres. Run: node test/hosted.test.mjs
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(CP, 'server.js'));
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'test-jwt-secret';
process.env.ASTRODOCK_SECRET_KEY ||= '0'.repeat(64);
process.env.ASTRODOCK_TLS_MODE ||= 'off';
process.env.ASTRODOCK_RUNNER_TOKEN ||= 'test-runner-token';
process.env.ASTRODOCK_FLEET_TOKEN = 'fleet-token-for-tests-0123456789';
process.env.ASTRODOCK_SETUP_TOKEN = 'setup-token-for-tests-abcdefgh';
const { app } = require(path.join(CP, 'server.js'));
const { db, schema, close } = require(CP + '/src/db/index.js');
const { eq, inArray } = require('drizzle-orm');
const totp = require(CP + '/src/lib/totp.js');
const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
const B = 'http://127.0.0.1:' + srv.address().port;
let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ok  ' + n); p++; } catch (e) { console.error('  FAIL ' + n + '\n       ' + e.message); f++; } };
const A = (c, m) => { if (!c) throw new Error(m || 'failed'); };
const J = async (m, u, b, tok, headers = {}) => {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

const EMAILS = ['own@hosted.test', 'view@hosted.test', 'end@hosted.test', 'other@hosted.test'];
const SLUGS = ['hs-one', 'hs-two', 'hs-new', 'hs-made'];
async function cleanup() {
  await db.delete(schema.apps).where(inArray(schema.apps.slug, SLUGS));
  await db.delete(schema.users).where(inArray(schema.users.email, EMAILS));
  await db.delete(schema.approvals);
  await db.delete(schema.cliLogins);
  await db.delete(schema.platformSettings).where(eq(schema.platformSettings.key, 'security.agent_approvals'));
}
await cleanup();
await db.update(schema.users).set({ operatorRole: 'admin' }).where(eq(schema.users.operatorRole, 'owner'));
const { hashPassword } = require(CP + '/src/lib/passwords.js');
const ph = await hashPassword('correct-horse-battery');
const [owner] = await db.insert(schema.users).values({ email: 'own@hosted.test', name: 'Own', passwordHash: ph, isActive: true, isAdmin: true, operatorRole: 'owner' }).returning();
await db.insert(schema.users).values({ email: 'view@hosted.test', name: 'View', passwordHash: ph, isActive: true, isAdmin: true, operatorRole: 'viewer' });
const [enduser] = await db.insert(schema.users).values({ email: 'end@hosted.test', name: 'End', passwordHash: ph, isActive: true, appAccess: ['hs-two'] }).returning();

const login = async (email) => (await J('POST', '/admin/login', { email, password: 'correct-horse-battery' })).d.token;
let OWN = await login('own@hosted.test');
const VIEW = await login('view@hosted.test');

// TOTP for the owner. A code is spendable once, so the spent step is cleared
// before each use.
const begin = await J('POST', '/admin/account/totp/begin', {}, OWN);
await J('POST', '/admin/account/totp/confirm', { code: totp.codeForStep(begin.d.secret, totp.stepFor()) }, OWN);
async function code() {
  await db.update(schema.users).set({ totpLastStep: null }).where(eq(schema.users.id, owner.id));
  return totp.codeForStep(begin.d.secret, totp.stepFor());
}

const manifest = (slug) => ({
  schemaVersion: '1', slug, name: slug, subdomain: slug, source: { branch: 'main' },
  runtime: { type: 'node' }, auth: { mode: 'platform' }, database: { mode: 'none' }, storage: { mode: 'none' }, env: []
});
// Apps for keys to work on, made by a person (who needs no approval).
for (const s of ['hs-one', 'hs-two']) {
  const r = await J('POST', '/admin/apps', { slug: s, name: s, subdomain: s }, OWN);
  A(r.s === 201, `seed ${s}: ${r.s} ${JSON.stringify(r.d)}`);
}
const KEY = (await J('POST', '/admin/tokens', { name: 'agent-one', preset: 'agent', apps: ['hs-one'] }, OWN)).d.token;
const KEY2 = (await J('POST', '/admin/tokens', { name: 'agent-two', preset: 'agent', apps: ['hs-two'] }, OWN)).d.token;
const ACCT = (await J('POST', '/admin/tokens', { name: 'agent-all', preset: 'agentAccount' }, OWN)).d.token;

console.log('approvals');
let AP;
await t('a key creating an app is asked for approval, with a link', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, ACCT);
  A(r.s === 403 && r.d.code === 'approval_required', `${r.s} ${JSON.stringify(r.d)}`);
  A(/\/approve\/[0-9a-f-]{36}$/.test(r.d.approval.url), r.d.approval.url);
  A(r.d.approval.details.slug === 'hs-new');
  AP = r.d.approval;
  const [row] = await db.select().from(schema.apps).where(eq(schema.apps.slug, 'hs-new'));
  A(!row, 'nothing was created');
});
await t('asking again returns the same approval, not a copy', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, ACCT);
  A(r.d.approval.id === AP.id, 'same id');
});
await t('repeating with the approval before anyone approves is refused', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, ACCT, { 'X-Astrodock-Approval': AP.id });
  A(r.s === 403 && r.d.code === 'approval_required', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a key can read its own approval and not another key\'s', async () => {
  A((await J('GET', `/admin/approvals/${AP.id}`, null, ACCT)).s === 200);
  A((await J('GET', `/admin/approvals/${AP.id}`, null, KEY)).s === 404);
});
await t('a key cannot approve', async () => {
  const r = await J('POST', `/admin/approvals/${AP.id}/approve`, { totp: await code() }, ACCT);
  A(r.s === 403, 'got ' + r.s);
});
await t('a viewer cannot approve what they could not do themselves', async () => {
  const r = await J('POST', `/admin/approvals/${AP.id}/approve`, { totp: '000000' }, VIEW);
  A(r.s === 403 && r.d.code === 'insufficient_scope', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('approving needs a passkey or authenticator code: a password is refused', async () => {
  const r = await J('POST', `/admin/approvals/${AP.id}/approve`, { password: 'correct-horse-battery' }, OWN);
  A(r.s === 401 && r.d.code === 'proof_required', `${r.s} ${JSON.stringify(r.d)}`);
  const wrong = await J('POST', `/admin/approvals/${AP.id}/approve`, { totp: '000000' }, OWN);
  A(wrong.s === 401, 'a wrong code too');
});
await t('an authenticator code approves it', async () => {
  const r = await J('POST', `/admin/approvals/${AP.id}/approve`, { totp: await code() }, OWN);
  A(r.s === 200 && r.d.approval.status === 'approved', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('another key cannot use it', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, KEY, { 'X-Astrodock-Approval': AP.id });
  A(r.s === 403 && r.d.code === 'approval_invalid', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('it is bound to the exact request', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: { ...manifest('hs-new'), name: 'Different' } }, ACCT, { 'X-Astrodock-Approval': AP.id });
  A(r.s === 403 && r.d.code === 'approval_mismatch', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('the same key repeating the same request goes through', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, ACCT, { 'X-Astrodock-Approval': AP.id });
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('and the approval is spent', async () => {
  await db.delete(schema.apps).where(eq(schema.apps.slug, 'hs-new'));
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, ACCT, { 'X-Astrodock-Approval': AP.id });
  A(r.s === 403 && r.d.code === 'approval_used', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('declining is final', async () => {
  const r0 = await J('POST', '/admin/apps', { slug: 'hs-made', name: 'Made', subdomain: 'hs-made' }, ACCT);
  A(r0.d.code === 'approval_required');
  const d = await J('POST', `/admin/approvals/${r0.d.approval.id}/deny`, {}, OWN);
  A(d.s === 200 && d.d.approval.status === 'denied');
  const r = await J('POST', '/admin/apps', { slug: 'hs-made', name: 'Made', subdomain: 'hs-made' }, ACCT, { 'X-Astrodock-Approval': r0.d.approval.id });
  A(r.s === 403 && r.d.code === 'approval_denied', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a person creating an app is not asked', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-made') }, OWN);
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
  await db.delete(schema.apps).where(eq(schema.apps.slug, 'hs-made'));
});
await t('applying to an app the key already has needs nothing', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-one') }, KEY);
  A(r.s === 200, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a key adding a custom domain is asked', async () => {
  const r = await J('POST', '/admin/apps/hs-one/domains', { hostname: 'www.example-hosted.test' }, KEY);
  A(r.s === 403 && r.d.code === 'approval_required' && r.d.approval.kind === 'domain.add', `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a key giving its app someone who already has an account is asked', async () => {
  const r = await J('POST', '/admin/users/invite', { email: 'end@hosted.test', appId: 'hs-one' }, KEY);
  A(r.s === 403 && r.d.code === 'approval_required' && r.d.approval.kind === 'user.access', `${r.s} ${JSON.stringify(r.d)}`);
  const r2 = await J('PUT', `/admin/users/${enduser.id}/access/hs-one`, {}, KEY);
  A(r2.s === 403 && r2.d.code === 'approval_required', `${r2.s} ${JSON.stringify(r2.d)}`);
});
await t('inviting a new address is not', async () => {
  const r = await J('POST', '/admin/users/invite', { email: 'other@hosted.test', appId: 'hs-one' }, KEY);
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a one-app key sees only the people who use its app', async () => {
  const r1 = await J('GET', '/admin/users', null, KEY);
  A(!r1.d.users.some((u) => u.email === 'end@hosted.test'), 'end user of another app is hidden');
  A(!r1.d.users.some((u) => u.email === 'own@hosted.test'), 'operators are hidden');
  const r2 = await J('GET', '/admin/users', null, KEY2);
  A(r2.d.users.some((u) => u.email === 'end@hosted.test'), 'visible to the key for their app');
  A((await J('GET', `/admin/users/${enduser.id}`, null, KEY)).s === 404, 'one by id too');
});
await t('turning approvals off lets a key act alone', async () => {
  const off = await J('PATCH', '/admin/settings', { updates: { 'security.agent_approvals': 'off' } }, OWN);
  A(off.s === 200, `${off.s} ${JSON.stringify(off.d)}`);
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-made') }, ACCT);
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
  await J('PATCH', '/admin/settings', { updates: { 'security.agent_approvals': 'on' } }, OWN);
  await db.delete(schema.apps).where(eq(schema.apps.slug, 'hs-made'));
});

console.log('\nastrodock login');
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
await t('starting needs a real challenge', async () => {
  const r = await J('POST', '/cli/login/start', { codeChallenge: 'short' });
  A(r.s === 400, 'got ' + r.s);
});
let L, PK;
await t('a start returns a device code, a user code and a page', async () => {
  PK = pkce();
  const r = await J('POST', '/cli/login/start', { codeChallenge: PK.challenge, client: { hostname: 'laptop', folder: 'hs-new', gitRemote: 'https://github.com/x/y' }, manifest: manifest('hs-new') });
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
  A(/^[A-Z]{4}-[A-Z]{4}$/.test(r.d.userCode), r.d.userCode);
  A(r.d.verificationUriComplete.endsWith(`/connect/${r.d.userCode}`));
  L = r.d;
});
await t('polling with the wrong verifier says nothing about the state', async () => {
  const r = await J('POST', '/cli/login/poll', { deviceCode: L.deviceCode, codeVerifier: pkce().verifier });
  A(r.s === 403 && !r.d.status, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('polling before approval is pending', async () => {
  const r = await J('POST', '/cli/login/poll', { deviceCode: L.deviceCode, codeVerifier: PK.verifier });
  A(r.s === 202 && r.d.status === 'pending');
});
await t('the approval page sees where it came from and what app.json asks for', async () => {
  const r = await J('GET', `/admin/cli-logins/${L.userCode}`, null, OWN);
  A(r.s === 200 && r.d.login.client.hostname === 'laptop' && r.d.login.manifest.slug === 'hs-new' && !r.d.login.existingApp);
});
await t('a viewer cannot approve a key', async () => {
  const r = await J('POST', `/admin/cli-logins/${L.userCode}/approve`, { kind: 'app', slug: 'hs-new', totp: '000000' }, VIEW);
  A(r.s === 403, 'got ' + r.s);
});
await t('approving needs the factor', async () => {
  const r = await J('POST', `/admin/cli-logins/${L.userCode}/approve`, { kind: 'app', slug: 'hs-new' }, OWN);
  A(r.s === 401 && r.d.code === 'proof_required');
});
await t('approving a key for the app.json\'s app creates the app', async () => {
  const r = await J('POST', `/admin/cli-logins/${L.userCode}/approve`, { kind: 'app', slug: 'hs-new', totp: await code() }, OWN);
  A(r.s === 200 && r.d.login.status === 'approved', `${r.s} ${JSON.stringify(r.d)}`);
  const [row] = await db.select().from(schema.apps).where(eq(schema.apps.slug, 'hs-new'));
  A(row, 'app created');
});
let LOGINKEY;
await t('the CLI collects a key for that app only, once', async () => {
  const r = await J('POST', '/cli/login/poll', { deviceCode: L.deviceCode, codeVerifier: PK.verifier });
  A(r.s === 200 && r.d.token.startsWith('tk_') && r.d.kind === 'app' && r.d.app === 'hs-new', `${r.s} ${JSON.stringify(r.d)}`);
  LOGINKEY = r.d.token;
  const again = await J('POST', '/cli/login/poll', { deviceCode: L.deviceCode, codeVerifier: PK.verifier });
  A(again.s === 410 && again.d.status === 'consumed');
  const me = await J('GET', '/whoami', null, LOGINKEY);
  A(JSON.stringify(me.d.apps) === '["hs-new"]', JSON.stringify(me.d.apps));
});
await t('the one-app key can apply its own app without approval', async () => {
  const r = await J('POST', '/admin/apps/apply', { manifest: manifest('hs-new') }, LOGINKEY);
  A(r.s === 200, `${r.s} ${JSON.stringify(r.d)}`);
});
await t('an account key covers every app and Pages', async () => {
  const k = pkce();
  const s = await J('POST', '/cli/login/start', { codeChallenge: k.challenge, client: { hostname: 'laptop' } });
  await J('POST', `/admin/cli-logins/${s.d.userCode}/approve`, { kind: 'account', totp: await code() }, OWN);
  const r = await J('POST', '/cli/login/poll', { deviceCode: s.d.deviceCode, codeVerifier: k.verifier });
  A(r.s === 200 && r.d.kind === 'account', JSON.stringify(r.d));
  const me = await J('GET', '/whoami', null, r.d.token);
  A(me.d.apps === 'all' && me.d.scopes.includes('pages:write') && !me.d.scopes.includes('tokens:write'), JSON.stringify(me.d));
});
await t('a declined sign-in tells the CLI so', async () => {
  const k = pkce();
  const s = await J('POST', '/cli/login/start', { codeChallenge: k.challenge });
  A((await J('POST', `/admin/cli-logins/${s.d.userCode}/deny`, {}, OWN)).s === 200);
  const r = await J('POST', '/cli/login/poll', { deviceCode: s.d.deviceCode, codeVerifier: k.verifier });
  A(r.s === 403 && r.d.status === 'denied');
});
await t('an expired sign-in cannot be approved or collected', async () => {
  const k = pkce();
  const s = await J('POST', '/cli/login/start', { codeChallenge: k.challenge });
  await db.update(schema.cliLogins).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.cliLogins.userCode, s.d.userCode.replace('-', '')));
  const a = await J('POST', `/admin/cli-logins/${s.d.userCode}/approve`, { kind: 'account', totp: await code() }, OWN);
  A(a.s === 409, 'got ' + a.s);
  const r = await J('POST', '/cli/login/poll', { deviceCode: s.d.deviceCode, codeVerifier: k.verifier });
  A(r.s === 410 && r.d.status === 'expired');
});

console.log('\nresource caps');
await t('a key cannot change its app\'s caps', async () => {
  const r = await J('PUT', '/admin/apps/hs-one/limits', { memoryMb: 4096 }, ACCT);
  A(r.s === 403, 'got ' + r.s);
});
await t('a person can, within the maximum', async () => {
  const bad = await J('PUT', '/admin/apps/hs-one/limits', { memoryMb: 999999 }, OWN);
  A(bad.s === 400, 'over the max is refused');
  const r = await J('PUT', '/admin/apps/hs-one/limits', { memoryMb: 1024, cpuMillis: 500 }, OWN);
  A(r.s === 200 && r.d.app.resources.memoryMb === 1024 && r.d.app.resources.cpuMillis === 500 && r.d.app.resources.custom.memory, JSON.stringify(r.d));
  const reset = await J('PUT', '/admin/apps/hs-one/limits', { memoryMb: null, cpuMillis: null }, OWN);
  A(!reset.d.app.resources.custom.memory, 'cleared back to the default');
});
await t('traffic sums what the sampler recorded', async () => {
  const hour = require(CP + '/src/runner/traffic.js').hourOf();
  await db.delete(schema.appTraffic).where(eq(schema.appTraffic.appSlug, 'hs-one'));
  await db.insert(schema.appTraffic).values({ appSlug: 'hs-one', hour, rxBytes: 100, txBytes: 2000 });
  const r = await J('GET', '/admin/apps/hs-one/traffic?hours=24', null, KEY);
  A(r.s === 200 && r.d.txBytes === 2000 && r.d.rxBytes === 100 && r.d.series.length === 1, JSON.stringify(r.d));
  await db.delete(schema.appTraffic).where(eq(schema.appTraffic.appSlug, 'hs-one'));
});
await t('the routing reload the runner calls needs the runner token', async () => {
  const r = await J('POST', '/_internal/routing/reload', {}, 'wrong');
  A(r.s === 401, 'got ' + r.s);
});

console.log('\nfleet');
await t('the fleet API refuses the wrong token', async () => {
  const r = await J('GET', '/fleet/status', null, 'nope');
  A(r.s === 401, 'got ' + r.s);
});
const FLEET = process.env.ASTRODOCK_FLEET_TOKEN;
await t('claiming refuses while an owner exists', async () => {
  const r = await J('POST', '/fleet/claim', { setupToken: process.env.ASTRODOCK_SETUP_TOKEN, baseDomain: 'cust.example.test', ownerEmail: 'other@hosted.test', tlsMode: 'off' }, FLEET);
  A(r.s === 409, 'got ' + r.s);
});

// A fresh instance: no operators at all. Everyone else is demoted for the rest
// of this file and the setup token is minted the way boot mints it.
const demoted = await db.select({ id: schema.users.id, role: schema.users.operatorRole }).from(schema.users);
await db.update(schema.users).set({ operatorRole: null });
await db.delete(schema.users).where(eq(schema.users.email, 'other@hosted.test'));
await require(CP + '/src/routes/setup.js').initSetup({ log: () => {} });
const config = require(CP + '/src/config.js');
const before = { baseDomain: config.baseDomain, tlsMode: config.tlsMode, acmeEmail: config.acmeEmail };
let CLAIM;
await t('claiming needs the setup token too', async () => {
  const r = await J('POST', '/fleet/claim', { setupToken: 'wrong-setup-token-123456', baseDomain: 'cust.example.test', ownerEmail: 'other@hosted.test', tlsMode: 'off' }, FLEET);
  A(r.s === 403, 'got ' + r.s);
});
const NEWFLEET = 'rotated-fleet-token-for-tests-abcdefghijklmnop';
await t('a claim has to replace the fleet token the droplet booted with', async () => {
  const r = await J('POST', '/fleet/claim', { setupToken: process.env.ASTRODOCK_SETUP_TOKEN, baseDomain: 'cust.example.test', ownerEmail: 'other@hosted.test', tlsMode: 'off' }, FLEET);
  A(r.s === 400 && /newFleetToken/.test(r.d.error), `${r.s} ${JSON.stringify(r.d)}`);
});
await t('a claim sets the domain and creates an owner with no way in but the link', async () => {
  const r = await J('POST', '/fleet/claim', { setupToken: process.env.ASTRODOCK_SETUP_TOKEN, baseDomain: 'cust.example.test', ownerEmail: 'other@hosted.test', ownerName: 'Other', tlsMode: 'off', next: '/connect/ABCD-EFGH', newFleetToken: NEWFLEET }, FLEET);
  A(r.s === 201, `${r.s} ${JSON.stringify(r.d)}`);
  A(r.d.adminUrl === 'http://admin.cust.example.test');
  A(/\/welcome\?next=%2Fconnect%2FABCD-EFGH#owner=os_/.test(r.d.ownerSetupUrl), r.d.ownerSetupUrl);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'other@hosted.test'));
  A(u.operatorRole === 'owner' && !u.passwordHash, 'owner, no password');
  CLAIM = r.d;
});
await t('after the claim, the token from user-data is refused and the new one works', async () => {
  A((await J('GET', '/fleet/status', null, FLEET)).s === 401, 'old token refused');
  A((await J('GET', '/fleet/status', null, NEWFLEET)).s === 200, 'new token accepted');
});
await t('a second claim is refused for good', async () => {
  const r = await J('POST', '/fleet/claim', { setupToken: process.env.ASTRODOCK_SETUP_TOKEN, baseDomain: 'x.example.test', ownerEmail: 'x@hosted.test', tlsMode: 'off', newFleetToken: NEWFLEET + 'x' }, NEWFLEET);
  A(r.s === 409, 'got ' + r.s);
});
await t('the fleet API will not move an instance back to an older version', async () => {
  const r = await J('POST', '/fleet/update', { toVersion: '0.0.1' }, NEWFLEET);
  A(r.s === 409 && r.d.code === 'downgrade', `${r.s} ${JSON.stringify(r.d)}`);
});
let WELCOME;
await t('the welcome link opens a session, once', async () => {
  const token = CLAIM.ownerSetupUrl.split('#owner=')[1];
  const r = await J('POST', '/setup/owner-link/exchange', { token });
  A(r.s === 200 && r.d.token, `${r.s} ${JSON.stringify(r.d)}`);
  WELCOME = r.d.token;
  const again = await J('POST', '/setup/owner-link/exchange', { token });
  A(again.s === 401, 'spent');
});
await t('status reports an owner not yet set up', async () => {
  const r = await J('GET', '/fleet/status', null, NEWFLEET);
  A(r.s === 200 && r.d.claimed && !r.d.ownerReady && r.d.baseDomain === 'cust.example.test', JSON.stringify(r.d));
});
await t('a new welcome link can be had until the owner sets up sign-in', async () => {
  const r = await J('POST', '/fleet/owner-link', {}, NEWFLEET);
  A(r.s === 201 && r.d.ownerSetupUrl.includes('#owner=os_'));
  const set = await J('PUT', '/admin/account/password', { password: 'a-good-password-here' }, WELCOME);
  A(set.s === 200, `${set.s} ${JSON.stringify(set.d)}`);
  const after = await J('POST', '/fleet/owner-link', {}, NEWFLEET);
  A(after.s === 409 && after.d.code === 'owner_ready', `${after.s} ${JSON.stringify(after.d)}`);
  const old = await J('POST', '/setup/owner-link/exchange', { token: r.d.ownerSetupUrl.split('#owner=')[1] });
  A(old.s === 401, 'an unused link is worthless once sign-in exists');
});
await t('the service can start a sign-in for a customer\'s CLI, and still cannot collect it', async () => {
  const k = pkce();
  const r = await J('POST', '/fleet/cli-login', { codeChallenge: k.challenge, client: { hostname: 'laptop' } }, NEWFLEET);
  A(r.s === 201 && r.d.deviceCode && r.d.userCode, JSON.stringify(r.d));
  const [row] = await db.select().from(schema.cliLogins).where(eq(schema.cliLogins.userCode, r.d.userCode.replace('-', '')));
  A(row.source === 'fleet');
  const poll = await J('POST', '/cli/login/poll', { deviceCode: r.d.deviceCode, codeVerifier: pkce().verifier });
  A(poll.s === 403, 'without the verifier, the device code is useless');
});

// Put the platform back the way the other test files expect it.
await db.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, ['platform.base_domain', 'platform.tls_mode', 'platform.acme_email', 'platform.setup_deferred', 'fleet.token_hash']));
config.applyRuntimeDomain(before);
for (const u of demoted) await db.update(schema.users).set({ operatorRole: u.role }).where(eq(schema.users.id, u.id));
await cleanup();
srv.close();
await close();
console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
