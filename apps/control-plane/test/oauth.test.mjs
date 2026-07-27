// Hosted login: redirect allowlisting and authorization-code handling.
// Integration — needs a live Postgres. Run: node test/oauth.test.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(CP, 'server.js'));
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';
process.env.ASTRODOCK_SECRET_KEY ||= '0'.repeat(64);

const { db, schema, close } = require(CP + '/src/db/index.js');
const oauth = require(CP + '/src/lib/oauth.js');
const { eq } = require('drizzle-orm');

let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ok  ' + n); p++; } catch (e) { console.error('  FAIL ' + n + '\n       ' + e.message); f++; } };
const thr = async (fn, re) => { let threw = false; try { await fn(); } catch (e) { threw = true; if (!re.test(e.message)) throw new Error('wrong error: ' + e.message); } if (!threw) throw new Error('expected a throw'); };
const assertF = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

await db.delete(schema.users).where(eq(schema.users.email, 'oa@test.com'));
await db.delete(schema.apps).where(eq(schema.apps.slug, 'oatest'));
const [user] = await db.insert(schema.users).values({ email: 'oa@test.com', name: 'O', passwordHash: 'x', appAccess: ['oatest'] }).returning();
const [app] = await db.insert(schema.apps).values({ slug: 'oatest', name: 'OA', subdomain: 'oatest', port: 3999, appSecret: 's', appJwtSecret: 'j' }).returning();

console.log('redirect allowlist');

await t('nothing is allowed until registered', async () => {
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com/cb') === false);
});

await t('exact match only — a prefix is not enough', async () => {
  await oauth.addRedirectUri(app.id, 'https://oatest.example.com/cb');
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com/cb') === true, 'exact');
  // The classic code-theft vector: attacker appends a path or changes the host.
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com/cb/../evil') === false, 'traversal');
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com/cb.evil') === false, 'suffix');
  assertF(await oauth.isAllowedRedirect(app.id, 'https://evil.com/cb') === false, 'other host');
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com') === false, 'bare origin');
});

await t('a trailing slash is the same URL, nothing else is', async () => {
  assertF(await oauth.isAllowedRedirect(app.id, 'https://oatest.example.com/cb/') === true);
});

await t('non-http schemes are refused before any comparison', async () => {
  assertF(await oauth.isAllowedRedirect(app.id, 'javascript:alert(1)') === false);
  assertF(await oauth.isAllowedRedirect(app.id, 'data:text/html,x') === false);
  assertF(await oauth.isAllowedRedirect(app.id, '/relative/path') === false);
});

await t('plain http is rejected except on loopback', async () => {
  await thr(() => oauth.addRedirectUri(app.id, 'http://oatest.example.com/cb'), /Use https/);
  await oauth.addRedirectUri(app.id, 'http://localhost:5173/callback');
  assertF(await oauth.isAllowedRedirect(app.id, 'http://localhost:5173/callback') === true);
});

console.log('\nauthorization codes');

await t('a code is single-use', async () => {
  const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: 'https://oatest.example.com/cb' });
  const u = await oauth.redeemCode({ code, appId: app.id, redirectUri: 'https://oatest.example.com/cb' });
  assertF(u.id === user.id, 'returns the user');
  await thr(() => oauth.redeemCode({ code, appId: app.id, redirectUri: 'https://oatest.example.com/cb' }), /not valid/);
});

await t('a code is bound to the app it was issued for', async () => {
  const [other] = await db.insert(schema.apps).values({ slug: 'oaother', name: 'X', subdomain: 'oaother', port: 3998, appSecret: 's', appJwtSecret: 'j' }).returning();
  const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: 'https://oatest.example.com/cb' });
  await thr(() => oauth.redeemCode({ code, appId: other.id, redirectUri: 'https://oatest.example.com/cb' }), /different app/);
  await db.delete(schema.apps).where(eq(schema.apps.id, other.id));
});

await t('a code is bound to its redirect URL', async () => {
  const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: 'https://oatest.example.com/cb' });
  await thr(() => oauth.redeemCode({ code, appId: app.id, redirectUri: 'http://localhost:5173/callback' }), /does not match/);
});

await t('a failed redemption still burns the code', async () => {
  // Otherwise a stolen code could be retried against each app until one matched.
  const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: 'https://oatest.example.com/cb' });
  await thr(() => oauth.redeemCode({ code, appId: app.id, redirectUri: 'http://localhost:5173/callback' }), /does not match/);
  await thr(() => oauth.redeemCode({ code, appId: app.id, redirectUri: 'https://oatest.example.com/cb' }), /not valid/);
});

await t('an expired code is refused', async () => {
  const code = await oauth.issueCode({ appId: app.id, userId: user.id, redirectUri: 'https://oatest.example.com/cb' });
  await db.update(schema.authorizationCodes).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.authorizationCodes.appId, app.id));
  await thr(() => oauth.redeemCode({ code, appId: app.id, redirectUri: 'https://oatest.example.com/cb' }), /expired/);
});

await db.delete(schema.apps).where(eq(schema.apps.id, app.id));
await db.delete(schema.users).where(eq(schema.users.id, user.id));
await close();
console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
