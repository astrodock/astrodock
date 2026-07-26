'use strict';

// First-run setup. This is the only router that answers before the platform has a
// domain, and it exists so that `docker compose up -d` is the whole install: the
// stack boots unconfigured, Caddy serves the admin SPA over http://<server-ip>
// (see provision/caddy.js setupBlock), and the operator finishes here.
//
// Two things get claimed in this flow, and they are guarded differently:
//   • The admin account — guarded by a SETUP TOKEN printed to the container logs.
//     Anyone who can reach port 80 before you do could otherwise own the box.
//   • The base domain — guarded by normal admin auth, because by then an admin exists.
//
// Once a base domain is set, /setup/status still answers (the UI uses it to decide
// whether to show the wizard) but the mutating routes refuse to re-run the claim.

const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { hashPassword } = require('../lib/passwords');
const { requireAdmin } = require('../middleware/auth');
const { setBootstrap } = require('../lib/settings');
const { normalizeHostname, validHostname } = require('../lib/domains');
const { emitEvent, actorFromAuth } = require('../lib/events');

const router = express.Router();

// ── setup token ───────────────────────────────────────────────────────────────
// Held in memory only. A restart mints a new one and reprints it, which is the
// behaviour we want: the token is a proof-of-log-access credential, not a secret
// worth persisting. Cleared for good once an admin exists.
let setupToken = null;

function mintSetupToken() {
  setupToken = crypto.randomBytes(24).toString('hex');
  return setupToken;
}

function clearSetupToken() {
  setupToken = null;
}

// Constant-time compare so the token can't be probed byte-by-byte.
function tokenMatches(candidate) {
  if (!setupToken || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function adminExists() {
  const rows = await db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.isAdmin, true)).limit(1);
  return !!rows[0];
}

// Called at boot. Prints the token only when there is genuinely no admin yet.
async function initSetup({ log = console.log } = {}) {
  if (await adminExists()) {
    clearSetupToken();
    return { needed: false };
  }
  const token = mintSetupToken();
  const where = config.isConfigured()
    ? `https://${config.adminSubdomain}.${config.baseDomain}`
    : 'http://<this-server-ip>';
  log('');
  log('  ┌─ Astrodock first-run setup ───────────────────────────────');
  log(`  │  Open   ${where}`);
  log(`  │  Token  ${token}`);
  log('  │');
  log('  │  The token proves you own this server. It is not stored,');
  log('  │  and a new one is printed if this container restarts.');
  log('  └───────────────────────────────────────────────────────────');
  log('');
  return { needed: true, token };
}

// ── routes ────────────────────────────────────────────────────────────────────

// Public. Tells the SPA which step to render. Deliberately leaks nothing: whether
// an admin exists is already observable from the login page.
router.get('/status', async (req, res) => {
  try {
    const hasAdmin = await adminExists();
    res.json({
      configured: config.isConfigured(),
      hasAdmin,
      needsClaim: !hasAdmin,
      baseDomain: config.baseDomain || '',
      adminSubdomain: config.adminSubdomain,
      tlsMode: config.tlsMode,
      acmeEmail: config.acmeEmail || '',
      publicIp: config.publicIp || '',
      complete: config.isConfigured() && hasAdmin
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim the admin account using the setup token. One-shot: refuses once an admin
// exists, so this can never be used to add a second admin or reset the first.
router.post('/claim', async (req, res) => {
  const { token, email, password, name } = req.body || {};
  try {
    if (await adminExists()) {
      return res.status(409).json({ error: 'An administrator already exists. Sign in instead.' });
    }
    if (!tokenMatches(token)) {
      return res.status(403).json({ error: 'Invalid setup token. Run `docker compose logs api` to see the current one.' });
    }
    const addr = String(email || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || String(password).length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters.' });
    }

    const passwordHash = await hashPassword(String(password));
    await db.insert(schema.users).values({
      email: addr, name: String(name || 'Admin'), passwordHash, isActive: true, isAdmin: true, appAccess: []
    });
    clearSetupToken();
    await emitEvent({
      category: 'audit', type: 'setup.admin_claimed', severity: 'info',
      message: `Administrator account created during first-run setup: ${addr}`,
      actorType: 'admin', actor: addr, targetType: 'user', targetId: addr,
      ip: req.ip || ''
    }).catch(() => {});
    res.status(201).json({ ok: true, email: addr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check the wildcard record before committing to a domain, so the operator finds
// out here rather than after Caddy has already failed to get a certificate.
router.post('/check-dns', requireAdmin, async (req, res) => {
  const host = normalizeHostname((req.body || {}).baseDomain);
  if (!validHostname(host)) {
    return res.status(400).json({ error: 'Enter a valid domain, e.g. apps.example.com' });
  }
  // Resolving the admin host is the real test: it proves the *wildcard* answers,
  // which is what every app subdomain will rely on.
  const probe = `${config.adminSubdomain}.${host}`;
  // ASTRODOCK_PUBLIC_IP if the operator set it; otherwise the address the browser
  // used to reach this box, which is the server's public IP by definition — no
  // outbound "what is my IP" call needed. Only accepted as a bare IP literal.
  const hint = String((req.body || {}).observedIp || '').trim();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hint) || /^[0-9a-f:]+$/i.test(hint);
  const expected = config.publicIp || (isIpLiteral ? hint : '');
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(probe).catch(() => []),
      dns.resolve6(probe).catch(() => [])
    ]);
    const found = [...v4, ...v6];
    if (!found.length) {
      return res.json({
        ok: false, probe, found: [], expected,
        message: `${probe} does not resolve yet. Add the wildcard record, then check again — DNS can take a few minutes.`
      });
    }
    const matches = !expected || found.includes(expected);
    res.json({
      ok: matches, probe, found, expected,
      message: matches
        ? `${probe} resolves to ${found.join(', ')}.`
        : `${probe} resolves to ${found.join(', ')}, but this server is ${expected}. Update the record to point here.`
    });
  } catch (err) {
    res.json({ ok: false, probe, found: [], expected, message: `Lookup failed: ${err.message}` });
  }
});

// Commit the domain. Persists it, applies it to the live config, and republishes
// routing — after which the operator is redirected to the real admin host.
router.post('/domain', requireAdmin, async (req, res) => {
  const { tlsMode, acmeEmail } = req.body || {};
  const baseDomain = normalizeHostname((req.body || {}).baseDomain);
  try {
    if (!validHostname(baseDomain)) {
      return res.status(400).json({ error: 'Enter a valid domain, e.g. apps.example.com' });
    }
    const mode = String(tlsMode || 'auto').toLowerCase();
    if (!['auto', 'internal', 'off'].includes(mode)) {
      return res.status(400).json({ error: 'HTTPS mode must be auto, internal or off.' });
    }
    const email = String(acmeEmail || '').trim();
    if (mode === 'auto' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Automatic HTTPS needs a contact email for the certificate authority.' });
    }

    const previous = config.baseDomain;
    const actor = actorFromAuth(req.auth);
    const applied = await setBootstrap({ baseDomain, tlsMode: mode, acmeEmail: email }, actor.actor);

    // Republish routing under the new hostnames. Two attempts, not the default
    // five: the operator is waiting on this response, and the full backoff is ~15s
    // of silence. A failure is reported, not fatal — the reconciler heals it.
    const { reloadCaddyWithRetry } = require('../provision');
    const routed = await reloadCaddyWithRetry(2).catch(() => false);

    await emitEvent({
      category: 'audit', type: 'setup.domain_set', severity: 'info',
      message: previous
        ? `Base domain changed from ${previous} to ${baseDomain} (HTTPS: ${mode})`
        : `Base domain set to ${baseDomain} (HTTPS: ${mode})`,
      ...actor, targetType: 'platform', targetId: baseDomain, ip: req.ip || ''
    }).catch(() => {});

    const scheme = mode === 'off' ? 'http' : 'https';
    res.json({
      ok: true,
      ...applied,
      routed,
      adminUrl: `${scheme}://${config.adminSubdomain}.${baseDomain}`,
      message: routed
        ? 'Routing published.'
        : 'Saved, but routing did not reload yet — it will retry automatically.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.initSetup = initSetup;
module.exports.adminExists = adminExists;
