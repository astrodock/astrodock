'use strict';

// `astrodock login`: how an agent gets a key without anyone copying one.
//
// The shape is the OAuth device flow, with PKCE on top:
//   1. The CLI starts a sign-in with the S256 hash of a verifier it keeps. It
//      gets a device code (to poll with) and a short user code (for a person).
//   2. The CLI opens /connect/<user code> in the browser. A signed-in person sees
//      where the request came from and what app.json asks for, chooses a key for
//      this app or for every app, and confirms with a passkey or authenticator
//      code (lib/strong-factor).
//   3. The CLI polls with the device code and the verifier, and collects the key
//      once. The key is minted at that moment, so it is never stored in the clear.
//
// The verifier is what lets a third party relay a sign-in without being able to
// finish it. The hosted service starts sign-ins for its customers' CLIs
// (routes/fleet.js) and so learns the device code, but never the verifier.

const crypto = require('crypto');
const { and, eq } = require('drizzle-orm');
const { validate } = require('@astrodock/schema');
const config = require('../config');
const { db, schema } = require('../db');
const { generateApiToken, hashToken } = require('./ids');
const { emitEvent } = require('./events');
const scopes = require('./scopes');
const sealed = require('./sealed');

const TTL_MS = 15 * 60 * 1000;
const POLL_INTERVAL_S = 3;
const KEY_TTL_DAYS = 90;
// RFC 8628 section 6.1: consonants only, so no code spells a word and nothing
// reads as a digit.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

class LoginError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function validChallenge(c) {
  return typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c);
}

function verifierMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newUserCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function normalizeUserCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function formatUserCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function adminOrigin() {
  if (!config.isConfigured()) return null;
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${config.adminSubdomain}.${config.baseDomain}`;
}

// What the CLI says about itself is shown to the person approving, so it is
// trimmed to plain short strings and nothing else is kept.
function cleanClient(client) {
  const c = client && typeof client === 'object' ? client : {};
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '');
  return {
    hostname: str(c.hostname, 100),
    folder: str(c.folder, 200),
    gitRemote: str(c.gitRemote, 300),
    platform: str(c.platform, 40),
    cliVersion: str(c.cliVersion, 40)
  };
}

function cleanManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { manifest: null, errors: [] };
  const { valid, errors } = validate(manifest);
  return valid ? { manifest, errors: [] } : { manifest: null, errors: errors.slice(0, 10) };
}

/** What the approval page shows about an app.json. */
function manifestSummary(m) {
  if (!m) return null;
  return {
    slug: m.slug,
    name: m.name,
    subdomain: m.subdomain,
    description: m.description || '',
    runtime: m.runtime?.type || 'node',
    database: m.database?.mode || 'none',
    storage: m.storage?.mode || 'none',
    auth: m.auth?.mode || 'platform',
    githubRepo: m.source?.githubRepo || '',
    env: (m.env || []).map((v) => ({ key: v.key, required: !!v.required, secret: !!v.secret }))
  };
}

async function start({ codeChallenge, clientPublicKey, client, manifest, source = 'cli' }) {
  if (!validChallenge(codeChallenge)) {
    throw new LoginError('code_challenge must be the base64url SHA-256 of a verifier (43 characters).');
  }
  // The key is only ever handed over sealed to this (lib/sealed), so it is
  // required: there is no path where a key travels in the clear.
  if (!sealed.validPublicKey(clientPublicKey)) {
    throw new LoginError('clientPublicKey must be a base64url X25519 public key (43 characters). Update the CLI.');
  }
  const cleaned = cleanManifest(manifest);
  const deviceCode = `dc_${crypto.randomBytes(32).toString('base64url')}`;

  // A collision on the user code is rare and harmless: try again.
  let row = null;
  for (let i = 0; i < 5 && !row; i++) {
    const userCode = newUserCode();
    try {
      [row] = await db.insert(schema.cliLogins).values({
        deviceCodeHash: sha256(deviceCode),
        userCode,
        codeChallenge,
        clientPublicKey,
        client: cleanClient(client),
        manifest: cleaned.manifest,
        source,
        expiresAt: new Date(Date.now() + TTL_MS)
      }).returning();
    } catch (err) {
      if (!/unique|duplicate/i.test(err.message)) throw err;
    }
  }
  if (!row) throw new LoginError('Could not start a sign-in. Try again.', 503);

  const origin = adminOrigin();
  const path = `/connect/${formatUserCode(row.userCode)}`;
  return {
    deviceCode,
    userCode: formatUserCode(row.userCode),
    checkCode: sealed.checkCode(codeChallenge, clientPublicKey),
    verificationUri: origin ? `${origin}/connect` : '/connect',
    verificationUriComplete: origin ? `${origin}${path}` : path,
    expiresIn: Math.round(TTL_MS / 1000),
    interval: POLL_INTERVAL_S,
    manifestErrors: cleaned.errors
  };
}

function statusOf(row) {
  if ((row.status === 'pending' || row.status === 'approved') && new Date(row.expiresAt) <= new Date()) return 'expired';
  return row.status;
}

async function findByUserCode(userCode) {
  const code = normalizeUserCode(userCode);
  if (code.length !== 8) return null;
  const [row] = await db.select().from(schema.cliLogins).where(eq(schema.cliLogins.userCode, code)).limit(1);
  return row || null;
}

/** For the approval page. */
async function describe(row) {
  const summary = manifestSummary(row.manifest);
  let existingApp = null;
  if (summary?.slug) {
    const [a] = await db.select({ slug: schema.apps.slug, name: schema.apps.name }).from(schema.apps)
      .where(eq(schema.apps.slug, summary.slug)).limit(1);
    existingApp = a || null;
  }
  return {
    userCode: formatUserCode(row.userCode),
    // What the person compares with their terminal. Derived from what the CLI
    // sent, so a relay that changed it cannot make the two match.
    checkCode: sealed.checkCode(row.codeChallenge, row.clientPublicKey),
    status: statusOf(row),
    source: row.source,
    client: row.client || {},
    manifest: summary,
    existingApp,
    kind: row.kind,
    appSlug: row.appSlug,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt
  };
}

/**
 * A person's decision. The caller has checked the person's role and factor.
 * For a one-app key, `slug` names an existing app, or the app.json's own app,
 * which is created here.
 */
async function approve(row, { user, kind, slug, canCreateApps }) {
  if (statusOf(row) !== 'pending') throw new LoginError(`This sign-in is ${statusOf(row)}.`, 409);
  if (kind !== 'app' && kind !== 'account') throw new LoginError('Choose a key for one app or for every app.');

  let appSlug = null;
  if (kind === 'app') {
    appSlug = String(slug || '').trim();
    if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(appSlug)) throw new LoginError('Choose which app this key is for.');
    const [existing] = await db.select({ id: schema.apps.id }).from(schema.apps)
      .where(eq(schema.apps.slug, appSlug)).limit(1);
    if (!existing) {
      if (!row.manifest || row.manifest.slug !== appSlug) {
        throw new LoginError(`There is no app "${appSlug}" yet, and the app.json sent with this sign-in is for a different one.`);
      }
      if (!canCreateApps) throw new LoginError('Creating an app needs the "apps:write" permission.', 403);
      const { applyManifest } = require('./apply');
      await applyManifest(row.manifest);
      await emitEvent({
        category: 'audit', type: 'app.created', severity: 'info',
        message: `${user.email} created "${appSlug}" while approving an astrodock login`,
        actorType: 'admin', actor: user.email, targetType: 'app', targetId: appSlug
      }).catch(() => {});
    }
  }

  const [updated] = await db.update(schema.cliLogins)
    .set({ status: 'approved', kind, appSlug, approvedByUserId: user.id, approvedAt: new Date() })
    .where(and(eq(schema.cliLogins.id, row.id), eq(schema.cliLogins.status, 'pending')))
    .returning();
  if (!updated) throw new LoginError('Someone else decided this sign-in first.', 409);

  await emitEvent({
    category: 'audit', type: 'cli_login.approved', severity: 'info',
    message: `${user.email} approved astrodock login from ${row.client?.hostname || 'an unnamed computer'}`
      + (kind === 'app' ? ` for "${appSlug}"` : ' for every app'),
    actorType: 'admin', actor: user.email, targetType: 'cli_login', targetId: row.id,
    meta: { kind, appSlug, client: row.client }
  }).catch(() => {});
  return updated;
}

async function deny(row, { user }) {
  if (statusOf(row) !== 'pending') throw new LoginError(`This sign-in is ${statusOf(row)}.`, 409);
  await db.update(schema.cliLogins).set({ status: 'denied', approvedByUserId: user.id, approvedAt: new Date() })
    .where(and(eq(schema.cliLogins.id, row.id), eq(schema.cliLogins.status, 'pending')));
  await emitEvent({
    category: 'audit', type: 'cli_login.denied', severity: 'info',
    message: `${user.email} declined astrodock login from ${row.client?.hostname || 'an unnamed computer'}`,
    actorType: 'admin', actor: user.email, targetType: 'cli_login', targetId: row.id
  }).catch(() => {});
}

function keyName(row) {
  const where = row.client?.hostname || row.client?.folder || 'CLI';
  return `astrodock login · ${row.kind === 'app' ? row.appSlug : 'All Apps'} · ${where}`.slice(0, 120);
}

/**
 * The CLI's poll. Returns { status } while waiting, and the key once.
 */
async function poll({ deviceCode, codeVerifier }) {
  const [row] = await db.select().from(schema.cliLogins)
    .where(eq(schema.cliLogins.deviceCodeHash, sha256(deviceCode || ''))).limit(1);
  if (!row) throw new LoginError('Unknown sign-in.', 404, 'unknown');
  // Checked before anything is said about the state, so a device code alone
  // does not even reveal whether the sign-in was approved.
  if (!verifierMatches(codeVerifier, row.codeChallenge)) throw new LoginError('That verifier does not match.', 403, 'bad_verifier');

  const state = statusOf(row);
  if (state === 'pending') return { status: 'pending', interval: POLL_INTERVAL_S };
  if (state !== 'approved') return { status: state };

  // Spent conditionally: a second poll racing this one gets "consumed".
  const [taken] = await db.update(schema.cliLogins).set({ status: 'consumed', consumedAt: new Date() })
    .where(and(eq(schema.cliLogins.id, row.id), eq(schema.cliLogins.status, 'approved')))
    .returning();
  if (!taken) return { status: 'consumed' };

  const preset = taken.kind === 'app' ? scopes.PRESETS.agent : scopes.PRESETS.agentAccount;
  const appScope = taken.kind === 'app' ? [taken.appSlug] : [];
  const expiresAt = new Date(Date.now() + KEY_TTL_DAYS * 86400 * 1000);
  const raw = generateApiToken();
  const name = keyName(taken);
  const [tok] = await db.insert(schema.apiTokens).values({
    name,
    tokenHash: hashToken(raw),
    scopes: preset.scopes,
    appScope,
    expiresAt,
    authorizedByUserId: taken.approvedByUserId,
    createdByTokenId: null
  }).returning();
  await db.update(schema.cliLogins).set({ tokenId: tok.id }).where(eq(schema.cliLogins.id, taken.id));

  await emitEvent({
    category: 'audit', type: 'token.created', severity: 'info',
    message: `Access key "${name}" created by astrodock login with ${preset.scopes.length} permission(s)`
      + (appScope.length ? ` for ${appScope.join(', ')}` : ' for every app'),
    actorType: 'system', actor: 'astrodock login', targetType: 'token', targetId: tok.id,
    meta: { scopes: preset.scopes, appScope, expiresAt, cliLoginId: taken.id }
  }).catch(() => {});

  return {
    status: 'approved',
    // The address goes inside the seal too: a relay that could change it would
    // have the CLI send the key there on every request after this one.
    sealed: sealed.seal(JSON.stringify({ token: raw, url: adminOrigin() }), taken.clientPublicKey, taken.codeChallenge),
    url: adminOrigin(),
    kind: taken.kind,
    app: taken.appSlug,
    scopes: preset.scopes,
    expiresAt
  };
}

module.exports = {
  start, poll, approve, deny, describe, findByUserCode, statusOf, manifestSummary,
  normalizeUserCode, formatUserCode, verifierMatches, validChallenge, keyName,
  LoginError, TTL_MS, POLL_INTERVAL_S
};
