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
//   • read a status summary, and start a version update
// It cannot mint keys, read app data, or sign in as anyone.

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

function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(config.fleetToken || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!config.fleetToken) return res.status(404).json({ error: 'Not found' });
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!tokenMatches(given)) return res.status(401).json({ error: 'unauthorized' });
  next();
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
  const { setupToken, baseDomain: rawDomain, acmeEmail, ownerEmail, ownerName, tlsMode, next } = req.body || {};
  try {
    if (await setup.adminExists()) return res.status(409).json({ error: 'This instance already has an owner.' });
    if (!setup.tokenMatches(setupToken)) return res.status(403).json({ error: 'Invalid setup token.' });

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

    // No password and no passkey: the welcome link is how this person gets in,
    // and it is the only thing that can open a session for an account like this.
    const [user] = await db.insert(schema.users).values({
      email, name: String(ownerName || '').trim() || 'Owner', passwordHash: null, isActive: true,
      isAdmin: true, operatorRole: 'owner', appAccess: []
    }).returning();
    setup.clearSetupToken();

    await setBootstrap({ baseDomain, tlsMode: mode, acmeEmail: contact }, 'hosted service');
    await setSetupDeferred(false, 'hosted service').catch(() => {});
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
    const { codeChallenge, client, manifest } = req.body || {};
    const out = await cliLogin.start({ codeChallenge, client, manifest, source: 'fleet' });
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
    const target = String((req.body || {}).toVersion || '').trim() || null;
    if (target && !require('../lib/version').isSemver(target)) {
      return res.status(400).json({ error: 'toVersion must be a version like 0.0.33.' });
    }
    const current = require('../lib/version').resolve();
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

module.exports = router;
