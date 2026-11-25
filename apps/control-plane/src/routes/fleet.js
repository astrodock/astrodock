'use strict';

// The hosted service's calls into one instance. See HOSTED_SERVICE.md.
//
// Off unless ASTRODOCK_FLEET_TOKEN is set; with no token every route here is a
// 404, so a self-hosted install has no fleet surface at all.
//
// What the fleet token can do is deliberately small:
//   • claim a fresh instance once, together with its setup token: set the
//     domain and create the owner by email
//   • mint a welcome link for the owner, only while the owner still has no way
//     to sign in
//   • start an `astrodock login` on behalf of a customer's CLI. A person still
//     approves it with a passkey or authenticator code, and the key can only be
//     collected with the CLI's verifier, which the service never sees
//   • read a status summary, and start a version update (never a downgrade)
// It cannot mint keys, read app data, or sign in as anyone. The token the
// droplet booted with is replaced at the claim (see tokenMatches).
//
// One exception, on one instance: where ASTRODOCK_ARTIFACTS_SERVICE is on (the
// hosted artifacts service, which the hosted service itself operates), the
// /artifacts routes below set up creators, mint each one an artifacts-only key,
// and open an artifact for a creator who has access to it. Off everywhere else,
// including every customer's own instance.

const crypto = require('crypto');
const express = require('express');
const { eq, gt, sql } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const setup = require('./setup');
const ownerSetup = require('../lib/owner-setup');
const cliLogin = require('../lib/cli-login');
const { setBootstrap, setSetupDeferred } = require('../lib/settings');
const { normalizeHostname, validHostname } = require('../lib/domains');
const { emitEvent } = require('../lib/events');

const router = express.Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ROTATED_KEY = 'fleet.token_hash';

// The token in .env came in through the droplet's user-data, which the cloud
// provider serves to anything on the box that asks its metadata address. So
// the claim replaces it: the service sends a new token, only its hash is kept,
// and from then on the one in user-data is refused.
async function rotatedHash() {
  const rows = await db.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, ROTATED_KEY)).limit(1);
  return rows[0] ? String(rows[0].value) : null;
}

async function tokenMatches(given) {
  const g = String(given || '');
  if (!g) return false;
  const rotated = await rotatedHash();
  if (rotated) {
    const a = Buffer.from(sha256(g));
    const b = Buffer.from(rotated);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(g);
  const b = Buffer.from(String(config.fleetToken || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!config.fleetToken) return res.status(404).json({ error: 'Not found' });
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  tokenMatches(given).then((ok) => {
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    next();
  }).catch((err) => res.status(500).json({ error: err.message }));
});

const audit = (type, message, meta = {}) => emitEvent({
  category: 'audit', type, severity: 'info', message, actorType: 'system', actor: 'hosted service', meta
}).catch(() => {});

async function owner() {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.operatorRole, 'owner')).limit(1);
  return row || null;
}

function adminUrl() {
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${config.adminSubdomain}.${config.baseDomain}`;
}

// ── claim ─────────────────────────────────────────────────────────────────────
// A pool instance boots unconfigured with a setup token the service chose. Both
// tokens are needed, so the fleet token alone cannot re-claim an instance, and
// once an owner exists this refuses for good.
router.post('/claim', async (req, res) => {
  const { setupToken, baseDomain: rawDomain, acmeEmail, ownerEmail, ownerName, tlsMode, next, newFleetToken } = req.body || {};
  try {
    if (await setup.adminExists()) return res.status(409).json({ error: 'This instance already has an owner.' });
    if (!setup.tokenMatches(setupToken)) return res.status(403).json({ error: 'Invalid setup token.' });
    if (typeof newFleetToken !== 'string' || newFleetToken.length < 32) {
      return res.status(400).json({ error: 'newFleetToken (32 characters or more) is required: the token from user-data stops working at the claim.' });
    }

    const baseDomain = normalizeHostname(rawDomain);
    if (!validHostname(baseDomain)) return res.status(400).json({ error: 'baseDomain is not a valid domain.' });
    const email = String(ownerEmail || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'ownerEmail is not a valid address.' });
    const mode = String(tlsMode || 'auto').toLowerCase();
    if (!['auto', 'internal', 'off'].includes(mode)) return res.status(400).json({ error: 'tlsMode must be auto, internal or off.' });
    const contact = String(acmeEmail || '').trim();
    if (mode === 'auto' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
      return res.status(400).json({ error: 'acmeEmail is required for automatic HTTPS.' });
    }

    // The domain first: it is safe to set twice. Then the owner and the new
    // fleet token together, so an owner never exists without the token having
    // been replaced; a retry after a failure part-way sees one state or the other.
    await setBootstrap({ baseDomain, tlsMode: mode, acmeEmail: contact }, 'hosted service');
    await setSetupDeferred(false, 'hosted service').catch(() => {});
    const user = await db.transaction(async (tx) => {
      // No password and no passkey: the welcome link is how this person gets in,
      // and it is the only thing that can open a session for an account like this.
      const [u] = await tx.insert(schema.users).values({
        email, name: String(ownerName || '').trim() || 'Owner', passwordHash: null, isActive: true,
        isAdmin: true, operatorRole: 'owner', appAccess: []
      }).returning();
      const rotated = { key: ROTATED_KEY, value: sha256(newFleetToken), updatedBy: 'hosted service', updatedAt: new Date() };
      await tx.insert(schema.platformSettings).values(rotated)
        .onConflictDoUpdate({ target: schema.platformSettings.key, set: rotated });
      return u;
    });
    setup.clearSetupToken();
    const { reloadCaddyWithRetry } = require('../provision');
    const routed = await reloadCaddyWithRetry(2).catch(() => false);

    const link = await ownerSetup.create(user.id, { next });
    await audit('setup.claimed_by_fleet', `Instance claimed for ${email} at ${baseDomain}`, { baseDomain });
    res.status(201).json({ ok: true, adminUrl: adminUrl(), ownerSetupUrl: link.url, linkExpiresAt: link.expiresAt, routed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── welcome link ──────────────────────────────────────────────────────────────
router.post('/owner-link', async (req, res) => {
  try {
    const o = await owner();
    if (!o) return res.status(409).json({ error: 'This instance has no owner yet.' });
    if (!await ownerSetup.needsSetup(o.id)) {
      return res.status(409).json({ error: 'The owner has already set up sign-in.', code: 'owner_ready', adminUrl: adminUrl() });
    }
    const link = await ownerSetup.create(o.id, { next: (req.body || {}).next });
    res.status(201).json({ ownerSetupUrl: link.url, linkExpiresAt: link.expiresAt, adminUrl: adminUrl() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── astrodock login, started for a customer's CLI ─────────────────────────────
router.post('/cli-login', async (req, res) => {
  try {
    const { codeChallenge, clientPublicKey, client, manifest } = req.body || {};
    const out = await cliLogin.start({ codeChallenge, clientPublicKey, client, manifest, source: 'fleet' });
    const o = await owner();
    res.status(201).json({ ...out, ownerNeedsSetup: o ? await ownerSetup.needsSetup(o.id) : true, adminUrl: adminUrl() });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── status ────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const version = require('../lib/version').resolve();
    const [{ n: appCount }] = await db.select({ n: sql`count(*)::int` }).from(schema.apps);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const traffic = await db.select({
      app: schema.appTraffic.appSlug,
      rx: sql`coalesce(sum(${schema.appTraffic.rxBytes}), 0)::bigint`,
      tx: sql`coalesce(sum(${schema.appTraffic.txBytes}), 0)::bigint`
    }).from(schema.appTraffic).where(gt(schema.appTraffic.hour, since)).groupBy(schema.appTraffic.appSlug);
    const o = await owner();
    res.json({
      version: version.version,
      configured: config.isConfigured(),
      baseDomain: config.baseDomain || null,
      claimed: !!o,
      ownerReady: o ? !await ownerSetup.needsSetup(o.id) : false,
      apps: appCount,
      platform: require('../lib/platform-health').getLast() || null,
      traffic24h: traffic.map((t) => ({ app: t.app, rxBytes: Number(t.rx), txBytes: Number(t.tx) }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── update ────────────────────────────────────────────────────────────────────
router.post('/update', async (req, res) => {
  try {
    const version = require('../lib/version');
    const target = String((req.body || {}).toVersion || '').trim() || null;
    if (target && !version.isSemver(target)) {
      return res.status(400).json({ error: 'toVersion must be a version like 0.0.33.' });
    }
    const current = version.resolve();
    // Forward only. Moving an instance back to an older release would bring its
    // fixed bugs back with it, so that stays a person's decision on the box.
    // A build with no release version cannot be compared, so it is not updated
    // from here at all.
    if (!version.isSemver(current.version)) {
      return res.status(409).json({ error: `This instance runs ${current.version}, which is not a release, so the fleet API does not update it.`, code: 'not_a_release' });
    }
    if (target && version.compare(target, current.version) < 0) {
      return res.status(409).json({ error: `This instance is on ${current.version}; the fleet API does not move it back to ${target}.`, code: 'downgrade' });
    }
    await emitEvent({
      category: 'audit', type: 'update.requested', severity: 'critical',
      actorType: 'system', actor: 'hosted service', targetType: 'platform', targetId: 'astrodock',
      message: `The hosted service requested an update to ${target || 'the latest release'}`
    }).catch(() => {});
    const { runner } = require('../runner/client');
    const r = await runner.update({ toVersion: target, currentVersion: current.version, actor: 'hosted service' });
    res.status(r.status === 200 ? 200 : (r.status || 502)).json(r.body || { error: 'The runner refused.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── the hosted artifacts service ─────────────────────────────────────────────
const artifactsService = express.Router();
artifactsService.use((req, res, next) => (config.artifacts.service ? next() : res.status(404).json({ error: 'Not found' })));

const normEmail = (e) => String(e || '').trim().toLowerCase();
const PLANS = () => Object.keys(config.artifacts.plans);

async function creatorByEmail(email) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, normEmail(email))).limit(1);
  return u || null;
}

// Set up a creator (or update one) and mint them a fresh artifacts-only key.
// Their earlier service keys are revoked, so the service holds one at a time.
// A guest who signed in to someone's artifact becomes a creator; an operator of
// any other kind is refused.
artifactsService.post('/creators', async (req, res) => {
  try {
    const b = req.body || {};
    const email = normEmail(b.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    const plan = b.plan || 'free';
    if (!PLANS().includes(plan)) return res.status(400).json({ error: `plan is one of: ${PLANS().join(', ')}` });
    let user = await creatorByEmail(email);
    if (user && user.operatorRole && user.operatorRole !== 'creator') {
      return res.status(409).json({ error: 'That address belongs to an operator of this instance.' });
    }
    if (!user) {
      [user] = await db.insert(schema.users).values({
        email, name: String(b.name || '').trim().slice(0, 200) || email.split('@')[0],
        passwordHash: null, passwordless: true, operatorRole: 'creator', isAdmin: false, appAccess: []
      }).returning();
    } else if (user.operatorRole !== 'creator') {
      [user] = await db.update(schema.users).set({ operatorRole: 'creator', updatedAt: new Date() }).where(eq(schema.users.id, user.id)).returning();
    }
    if (!user.isActive) return res.status(409).json({ error: 'That account is turned off.' });
    await db.insert(schema.artifactAccounts).values({ userId: user.id, plan })
      .onConflictDoUpdate({ target: schema.artifactAccounts.userId, set: { plan, updatedAt: new Date() } });
    const { generateApiToken, hashToken } = require('../lib/ids');
    const { and: andOp, isNull } = require('drizzle-orm');
    await db.update(schema.apiTokens).set({ revokedAt: new Date() })
      .where(andOp(eq(schema.apiTokens.authorizedByUserId, user.id), eq(schema.apiTokens.name, 'hosted service'), isNull(schema.apiTokens.revokedAt)));
    const raw = generateApiToken();
    await db.insert(schema.apiTokens).values({
      name: 'hosted service', tokenHash: hashToken(raw), scopes: ['artifacts:read', 'artifacts:write'], appScope: [], authorizedByUserId: user.id
    });
    audit('artifacts.creator_ready', `Creator ${email} set up on the ${plan} plan`, { email, plan });
    res.status(201).json({ userId: user.id, email, plan, token: raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

artifactsService.post('/creators/plan', async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!PLANS().includes(plan)) return res.status(400).json({ error: `plan is one of: ${PLANS().join(', ')}` });
    const user = await creatorByEmail(email);
    if (!user || user.operatorRole !== 'creator') return res.status(404).json({ error: 'No such creator.' });
    await db.insert(schema.artifactAccounts).values({ userId: user.id, plan })
      .onConflictDoUpdate({ target: schema.artifactAccounts.userId, set: { plan, updatedAt: new Date() } });
    audit('artifacts.creator_plan', `Creator ${user.email} moved to the ${plan} plan`, { email: user.email, plan });
    res.json({ email: user.email, plan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Suspend: every artifact they own is taken down and they cannot make more.
// Restoring brings back only what this took down.
artifactsService.post('/creators/suspend', async (req, res) => {
  try {
    const { email, suspended } = req.body || {};
    const user = await creatorByEmail(email);
    if (!user || user.operatorRole !== 'creator') return res.status(404).json({ error: 'No such creator.' });
    const REASON = 'Account suspended';
    const now = new Date();
    await db.insert(schema.artifactAccounts).values({ userId: user.id, suspendedAt: suspended ? now : null })
      .onConflictDoUpdate({ target: schema.artifactAccounts.userId, set: { suspendedAt: suspended ? now : null, updatedAt: now } });
    const { and: andOp, isNull } = require('drizzle-orm');
    if (suspended) {
      await db.update(schema.artifacts).set({ suspendedAt: now, suspendedReason: REASON, updatedAt: now })
        .where(andOp(eq(schema.artifacts.ownerId, user.id), isNull(schema.artifacts.suspendedAt)));
    } else {
      await db.update(schema.artifacts).set({ suspendedAt: null, suspendedReason: '', updatedAt: now })
        .where(andOp(eq(schema.artifacts.ownerId, user.id), eq(schema.artifacts.suspendedReason, REASON)));
    }
    audit(suspended ? 'artifacts.creator_suspended' : 'artifacts.creator_restored', `Creator ${user.email} ${suspended ? 'suspended' : 'restored'}`, { email: user.email });
    res.json({ email: user.email, suspended: !!suspended });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Keys for a creator's own agents, made when they approve one from the hosted
// service's connect page. Separate from the service's own key: making or
// revoking one leaves the others alone. Artifacts only, like the creator.
const AGENT_PREFIX = 'agent: ';
artifactsService.post('/creators/keys', async (req, res) => {
  try {
    const { email, name } = req.body || {};
    const user = await creatorByEmail(email);
    if (!user || user.operatorRole !== 'creator' || !user.isActive) return res.status(404).json({ error: 'No such creator.' });
    const { generateApiToken, hashToken } = require('../lib/ids');
    const raw = generateApiToken();
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const label = `${AGENT_PREFIX}${String(name || 'agent').replace(/[\u0000-\u001f]/g, '').slice(0, 80)}`;
    const [row] = await db.insert(schema.apiTokens).values({
      name: label, tokenHash: hashToken(raw), scopes: ['artifacts:read', 'artifacts:write'], appScope: [], authorizedByUserId: user.id
    }).returning();
    audit('artifacts.agent_key', `Agent key "${label}" made for ${user.email}`, { email: user.email, tokenId: row.id });
    res.status(201).json({ id: row.id, name: label, token: raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

artifactsService.post('/creators/keys/list', async (req, res) => {
  try {
    const user = await creatorByEmail((req.body || {}).email);
    if (!user || user.operatorRole !== 'creator') return res.status(404).json({ error: 'No such creator.' });
    const { and: andOp, isNull, like } = require('drizzle-orm');
    const rows = await db.select().from(schema.apiTokens)
      .where(andOp(eq(schema.apiTokens.authorizedByUserId, user.id), isNull(schema.apiTokens.revokedAt), like(schema.apiTokens.name, `${AGENT_PREFIX}%`)));
    res.json({ keys: rows.map((t) => ({ id: t.id, name: t.name.slice(AGENT_PREFIX.length), createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

artifactsService.post('/creators/keys/revoke', async (req, res) => {
  try {
    const { email, id } = req.body || {};
    const user = await creatorByEmail(email);
    if (!user || user.operatorRole !== 'creator' || !/^[0-9a-f-]{36}$/i.test(String(id || ''))) return res.status(404).json({ error: 'No such key.' });
    const { and: andOp, like } = require('drizzle-orm');
    const rows = await db.update(schema.apiTokens).set({ revokedAt: new Date() })
      .where(andOp(eq(schema.apiTokens.id, id), eq(schema.apiTokens.authorizedByUserId, user.id), like(schema.apiTokens.name, `${AGENT_PREFIX}%`))).returning();
    if (!rows[0]) return res.status(404).json({ error: 'No such key.' });
    audit('artifacts.agent_key_revoked', `Agent key "${rows[0].name}" of ${user.email} revoked`, { email: user.email, tokenId: id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Open an artifact for a creator signed in at the hosted service: a one-time
// grant for that artifact only, and only if they have access to it. The
// service redirects the browser to the URL returned.
artifactsService.post('/open', async (req, res) => {
  try {
    const A = require('../lib/artifacts/access');
    const { email, artifactId, next } = req.body || {};
    const user = await creatorByEmail(email);
    const artifact = /^[a-z0-9]{12}$/.test(String(artifactId || '')) ? await A.loadArtifact(artifactId) : null;
    if (!user || !user.isActive || !artifact || !artifact.isActive || artifact.suspendedAt || !(await A.hasAccess(artifact, user))) {
      return res.status(404).json({ error: 'No such artifact for that person.' });
    }
    const code = await A.issueGrant(artifact, user);
    const url = new URL(`${config.artifactOrigin(artifact.publicId)}/_astrodock/callback`);
    url.searchParams.set('code', code);
    const n = String(next || '/');
    url.searchParams.set('next', n.startsWith('/') && !n.startsWith('//') ? n : '/');
    require('../lib/artifacts/logs').signin(artifact, req, user.email, 'silent');
    res.json({ url: url.toString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.use('/artifacts', artifactsService);

module.exports = router;
