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
const jwt = require('jsonwebtoken');
const dns = require('dns').promises;
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { hashPassword } = require('../lib/passwords');
const { requireAdmin } = require('../middleware/auth');
const { setBootstrap, isSetupDeferred, setSetupDeferred } = require('../lib/settings');
const { MIN_PASSWORD_LENGTH } = require('../lib/auth-factors');
const { normalizeHostname, validHostname } = require('../lib/domains');
const { emitEvent, actorFromAuth } = require('../lib/events');

const router = express.Router();

// ── setup token ───────────────────────────────────────────────────────────────
// Held in memory only. A restart mints a new one and reprints it, which is the
// behaviour we want: the token is a proof-of-log-access credential, not a secret
// worth persisting. Cleared for good once an admin exists.
//
// It can also be supplied at install time via ASTRODOCK_SETUP_TOKEN. That is what
// removes the log-reading step — and with it the only reason to open a terminal on
// a cloud install: you put a token you already know into the provider's user-data
// field, and go straight to the browser. It stops being a secret the moment the
// account is claimed, which is why this is preferable to seeding a password that
// stays valid forever in instance metadata.
let setupToken = null;

// A short operator-supplied token would be brute-forceable over the open internet
// in the window before the account is claimed, which the generated 48-char one is
// not. Reject rather than silently accept a weak one.
const MIN_PRESET_TOKEN_LENGTH = 16;

function validatePresetToken(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (v.length < MIN_PRESET_TOKEN_LENGTH) {
    return { ok: false, reason: `shorter than ${MIN_PRESET_TOKEN_LENGTH} characters` };
  }
  if (/\s/.test(v)) return { ok: false, reason: 'contains whitespace' };
  return { ok: true, value: v };
}

function mintSetupToken() {
  const preset = validatePresetToken(config.setupToken);
  if (preset.ok) {
    setupToken = preset.value;
    return { token: setupToken, preset: true };
  }
  if (config.setupToken) {
    console.warn(`WARNING: ASTRODOCK_SETUP_TOKEN ignored (${preset.reason}) — generating one instead.`);
  }
  setupToken = crypto.randomBytes(24).toString('hex');
  return { token: setupToken, preset: false };
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
  // Asks about OPERATORS, not the legacy is_admin flag: after the role migration
  // operator_role is authoritative, and a fresh install has neither.
  const rows = await db.select({ id: schema.users.id, operatorRole: schema.users.operatorRole })
    .from(schema.users);
  return rows.some((r) => !!r.operatorRole);
}

// Called at boot. Prints the token only when there is genuinely no admin yet.
async function initSetup({ log = console.log } = {}) {
  if (await adminExists()) {
    clearSetupToken();
    return { needed: false };
  }
  const { token, preset } = mintSetupToken();
  const where = config.isConfigured()
    ? `https://${config.adminSubdomain}.${config.baseDomain}`
    : 'http://<this-server-ip>';
  log('');
  log('  ┌─ Astrodock first-run setup ───────────────────────────────');
  log(`  │  Open   ${where}`);
  if (preset) {
    // Deliberately not echoed: an operator-supplied token is already known to
    // whoever needs it, and logs get shipped to places the token shouldn't reach.
    log('  │  Token  (the one you set at install time)');
    log('  │');
    log('  │  It stops working the moment the account is claimed.');
  } else {
    log(`  │  Token  ${token}`);
    log('  │');
    log('  │  The token proves you own this server. It is not stored,');
    log('  │  and a new one is printed if this container restarts.');
  }
  log('  └───────────────────────────────────────────────────────────');
  log('');
  return { needed: true, token, preset };
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
      // Lets the wizard say "the token you chose at install time" instead of
      // telling someone to SSH in and grep logs for a token they already have.
      // Safe to expose: knowing a token was operator-chosen doesn't help guess it,
      // and this only ever answers before an admin exists.
      tokenSource: hasAdmin ? null : (validatePresetToken(config.setupToken).ok ? 'preset' : 'generated'),
      // The dashboard shell reads this at mount, which is the one call it always
      // makes — so the sidebar can show the version without a request of its own.
      version: require('../lib/version').resolve().version,
      baseDomain: config.baseDomain || '',
      adminSubdomain: config.adminSubdomain,
      tlsMode: config.tlsMode,
      acmeEmail: config.acmeEmail || '',
      publicIp: config.publicIp || '',
      deferred: await isSetupDeferred(),
      // "Complete" means "stop showing the wizard", not "fully configured". Someone
      // who chose to set their domain later gets the dashboard over the server's IP
      // instead of being held at a form they cannot fill in yet.
      complete: hasAdmin && (config.isConfigured() || await isSetupDeferred())
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
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const passwordHash = await hashPassword(String(password));
    await db.insert(schema.users).values({
      email: addr, name: String(name || 'Admin'), passwordHash, isActive: true,
      isAdmin: true,
      // The first account is the OWNER — the one role that cannot be removed, so an
      // install always has someone who can undo anything.
      operatorRole: 'owner',
      appAccess: []
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

// ── DNS automation ────────────────────────────────────────────────────────────
// Creating the wildcard record is the one step of the install that is genuinely
// manual, unbounded in time, and easy to get subtly wrong. If the operator's DNS
// lives somewhere with an API, we can just do it.

router.get('/dns/providers', requireAdmin, (req, res) => {
  res.json({ providers: require('../lib/dns-providers').list() });
});

router.post('/dns/create', requireAdmin, async (req, res) => {
  const { provider, token } = req.body || {};
  const baseDomain = normalizeHostname((req.body || {}).baseDomain);
  const observed = String((req.body || {}).observedIp || '').trim();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(observed);
  const ip = config.publicIp || (isIpLiteral ? observed : '');
  try {
    if (!validHostname(baseDomain)) {
      return res.status(400).json({ error: 'Enter a valid domain first, e.g. apps.example.com' });
    }
    const result = await require('../lib/dns-providers').createWildcard({ provider, token, baseDomain, ip });
    // The token is deliberately not persisted, and not echoed back.
    await emitEvent({
      category: 'audit', type: 'setup.dns_record_created', severity: 'info',
      message: `Wildcard DNS record ${result.record} created via ${provider} for ${baseDomain}`,
      ...actorFromAuth(req.auth), targetType: 'platform', targetId: baseDomain, ip: req.ip || ''
    }).catch(() => {});
    res.json({ ok: true, ...result, ip });
  } catch (err) {
    // Provider messages are written to be read by the operator; pass them through.
    res.status(400).json({ error: err.message });
  }
});

// ── session handoff across the domain switch ─────────────────────────────────
// Setting the domain moves the operator from http://<ip> to https://admin.<domain>.
// That is a different ORIGIN, so the browser's sessionStorage — and with it their
// login — does not follow. Being bounced to a login screen as the last act of setup
// reads like something broke.
//
// So: mint a nonce here, hand it over in the URL FRAGMENT (fragments are not sent
// to servers and stay out of access logs, unlike a query string), and let the new
// origin trade it for a real token. The nonce is single-use and short-lived, and it
// is not itself a credential — it only names an entry in this map.
const handoffs = new Map();
const HANDOFF_TTL_MS = 5 * 60 * 1000;

function mintHandoff(user) {
  for (const [k, v] of handoffs) if (v.expires < Date.now()) handoffs.delete(k);
  const nonce = crypto.randomBytes(24).toString('hex');
  handoffs.set(nonce, { user, expires: Date.now() + HANDOFF_TTL_MS });
  return nonce;
}

router.post('/handoff', async (req, res) => {
  const nonce = String((req.body || {}).nonce || '');
  const entry = handoffs.get(nonce);
  // Consume on lookup, valid or not — a nonce gets exactly one attempt.
  handoffs.delete(nonce);
  if (!entry || entry.expires < Date.now()) {
    return res.status(401).json({ error: 'That sign-in link has expired. Please sign in.' });
  }
  const token = jwt.sign(
    { sub: entry.user.id, email: entry.user.email, isAdmin: true },
    config.adminJwtSecret,
    { expiresIn: '8h' }
  );
  res.json({ token, user: { id: entry.user.id, email: entry.user.email } });
});

// Skip the domain step for now. Nothing is configured — this only records that the
// operator made the choice, so the wizard stops blocking the dashboard. Setting a
// domain later clears it.
router.post('/defer', requireAdmin, async (req, res) => {
  try {
    const actor = actorFromAuth(req.auth);
    await setSetupDeferred(true, actor.actor);
    await emitEvent({
      category: 'audit', type: 'setup.domain_deferred', severity: 'info',
      message: 'Domain setup deferred — the platform is reachable only by IP until one is set',
      ...actor, targetType: 'platform', ip: req.ip || ''
    }).catch(() => {});
    res.json({ ok: true, deferred: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What would change break? Passkeys are bound to the admin hostname, so moving the
// base domain invalidates them. Reported so the UI can warn — never used to block,
// since an enrolled credential should not hold the platform's routing hostage.
router.post('/domain/impact', requireAdmin, async (req, res) => {
  const baseDomain = normalizeHostname((req.body || {}).baseDomain);
  if (!validHostname(baseDomain)) return res.status(400).json({ error: 'Enter a valid domain.' });
  try {
    res.json(await require('../lib/passkeys').credentialsAtRisk(baseDomain));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    // A domain now exists, so the "I'll do it later" state is no longer meaningful.
    await setSetupDeferred(false, actor.actor).catch(() => {});

    // Republish routing under the new hostnames. Two attempts, not the default
    // five: the operator is waiting on this response, and the full backoff is ~15s
    // of silence. A failure is reported, not fatal — the reconciler heals it.
    const { reloadCaddyWithRetry } = require('../provision');
    const routed = await reloadCaddyWithRetry(2).catch(() => false);

    // Passkeys stop working at the new hostname; say so where it will be seen later.
    let atRisk = { count: 0, users: 0 };
    try { atRisk = await require('../lib/passkeys').credentialsAtRisk(baseDomain); } catch { /* non-fatal */ }

    await emitEvent({
      category: 'audit', type: 'setup.domain_set',
      severity: atRisk.count > 0 ? 'warning' : 'info',
      message: previous
        ? `Base domain changed from ${previous} to ${baseDomain} (HTTPS: ${mode})`
        : `Base domain set to ${baseDomain} (HTTPS: ${mode})`
        + (atRisk.count ? ` — ${atRisk.count} passkey(s) across ${atRisk.users} account(s) no longer work and must be re-enrolled` : ''),
      ...actor, targetType: 'platform', targetId: baseDomain, ip: req.ip || '',
      meta: { passkeysInvalidated: atRisk.count }
    }).catch(() => {});

    const scheme = mode === 'off' ? 'http' : 'https';
    // Look up the acting admin so the new origin can be handed a real session.
    let handoff = null;
    try {
      const rows = await db.select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users).where(eq(schema.users.email, req.auth.email)).limit(1);
      if (rows[0]) handoff = mintHandoff(rows[0]);
    } catch { /* a failed handoff just means one extra sign-in */ }

    res.json({
      ok: true,
      ...applied,
      routed,
      handoff,
      adminUrl: `${scheme}://${config.adminSubdomain}.${baseDomain}`,
      passkeysInvalidated: atRisk.count,
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
module.exports.validatePresetToken = validatePresetToken;
module.exports.MIN_PRESET_TOKEN_LENGTH = MIN_PRESET_TOKEN_LENGTH;
