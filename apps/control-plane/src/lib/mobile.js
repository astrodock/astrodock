'use strict';

// The mobile app's credentials: sign-in codes, device tokens and tickets.
// See MOBILE_DESIGN.md, sections 2, 3 and 5.
//
// The app is a public client. It holds no secret, so a code alone must not be
// enough to sign in: anything else on the phone that registered the same URL
// scheme could receive it. PKCE closes that. The app keeps a random verifier,
// sends only its SHA-256 (the challenge) to /mobile/authorize, and must present
// the verifier to redeem the code.
//
// Everything secret here is stored as a SHA-256 hash and returned exactly once.

const crypto = require('crypto');
const { and, eq, isNull, gt, lt, desc, count } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { getSetting } = require('./settings');

const REDIRECT_URI = 'astrodock://auth';
const CODE_TTL_MS = 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const DEVICE_IDLE_MS = 90 * 864e5;
const INBOX_DAYS = 90;
const PLATFORMS = ['ios', 'android'];
const ENVIRONMENTS = ['sandbox', 'production'];

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

class MobileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function enabled() {
  return (await getSetting('mobile.enabled', 'on')) !== 'off';
}

// ── input checks (pure) ──────────────────────────────────────────────────────

// An S256 challenge is base64url(sha256(verifier)): 32 bytes, 43 characters.
function validChallenge(c) {
  return typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c);
}

// RFC 7636: 43 to 128 characters from the unreserved set.
function validVerifier(v) {
  return typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
}

function s256(verifier) {
  return crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
}

function verifierMatches(verifier, challenge) {
  if (!validVerifier(verifier) || !validChallenge(challenge)) return false;
  const a = Buffer.from(s256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A path inside an app. Must start with one slash: `//evil.test` is a
// scheme-relative URL to another host, and a backslash is read as a slash by
// browsers. Control characters would let a path smuggle a header or a newline.
function validPath(p) {
  if (typeof p !== 'string') return false;
  if (p.length < 1 || p.length > 2000) return false;
  if (!p.startsWith('/') || p.startsWith('//')) return false;
  if (p.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return true;
}

function redirectFor(code, state) {
  const u = new URL(REDIRECT_URI);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', String(state));
  return u.toString();
}

// ── sign-in codes ────────────────────────────────────────────────────────────

async function issueCode({ userId, codeChallenge }) {
  if (!validChallenge(codeChallenge)) throw new MobileError('code_challenge must be an S256 challenge.');
  const code = random('amc_');
  await db.insert(schema.mobileCodes).values({
    codeHash: hash(code),
    userId,
    codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });
  return code;
}

/**
 * Spend a code. Burned before it is checked, as in lib/oauth: a code that has
 * been seen with the wrong verifier is not left lying around to be guessed at.
 * The UPDATE is conditional, so two requests racing with one code cannot both
 * get past it.
 */
async function redeemCode({ code, verifier }) {
  if (typeof code !== 'string' || !code) throw new MobileError('That sign-in code is not valid.');
  const spent = await db.update(schema.mobileCodes).set({ usedAt: new Date() })
    .where(and(eq(schema.mobileCodes.codeHash, hash(code)), isNull(schema.mobileCodes.usedAt)))
    .returning();
  const row = spent[0];
  if (!row) throw new MobileError('That sign-in code is not valid.');
  if (new Date(row.expiresAt) <= new Date()) throw new MobileError('That sign-in code has expired.');
  if (!verifierMatches(verifier, row.codeChallenge)) throw new MobileError('That sign-in code is not valid.');

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!user || !user.isActive) throw new MobileError('That account is not active.');
  return user;
}

// ── devices ──────────────────────────────────────────────────────────────────

function cleanDevice(device) {
  const d = device && typeof device === 'object' ? device : {};
  const platform = String(d.platform || '');
  if (!PLATFORMS.includes(platform)) throw new MobileError('device.platform must be ios or android.');
  return {
    name: String(d.name || '').trim().slice(0, 100),
    platform,
    appVersion: String(d.appVersion || '').trim().slice(0, 40)
  };
}

async function createDevice({ userId, device }) {
  const d = cleanDevice(device);
  const token = random('adt_');
  const [row] = await db.insert(schema.mobileDevices).values({
    userId,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + DEVICE_IDLE_MS)
  }).returning();
  return { device: row, token };
}

/**
 * The device and its user for a bearer token, or null. Null covers unknown,
 * revoked, expired and an inactive user alike: the app's answer to each is the
 * same, sign in again. A good token is extended by another 90 days.
 */
async function authenticate(token) {
  if (typeof token !== 'string' || !token.startsWith('adt_')) return null;
  const rows = await db.select().from(schema.mobileDevices)
    .where(eq(schema.mobileDevices.tokenHash, hash(token))).limit(1);
  const device = rows[0];
  if (!device || device.revokedAt || new Date(device.expiresAt) <= new Date()) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, device.userId)).limit(1);
  if (!user || !user.isActive) return null;
  const now = new Date();
  await db.update(schema.mobileDevices)
    .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + DEVICE_IDLE_MS) })
    .where(eq(schema.mobileDevices.id, device.id));
  return { device: { ...device, lastSeenAt: now }, user };
}

// What leaves the server about a device. No hashes.
function publicDevice(d) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    push: !!d.pushHandle,
    pushHandle: d.pushHandle || null,
    pushPublicKey: d.pushPublicKey || null,
    pushEnvironment: d.pushEnvironment || null,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    expiresAt: d.expiresAt
  };
}

// Signed-in devices only: revoked and lapsed ones are not something a person
// can do anything about.
async function listDevices(userId) {
  const rows = await db.select().from(schema.mobileDevices)
    .where(and(
      eq(schema.mobileDevices.userId, userId),
      isNull(schema.mobileDevices.revokedAt),
      gt(schema.mobileDevices.expiresAt, new Date())
    ))
    .orderBy(desc(schema.mobileDevices.lastSeenAt));
  return rows.map(publicDevice);
}

/**
 * Revoke one of a user's devices. Its push fields go too, so nothing is sent to
 * a phone that has signed out. Returns the device, or null if there was none.
 */
async function revokeDevice({ userId, deviceId }) {
  const rows = await db.update(schema.mobileDevices)
    .set({ revokedAt: new Date(), pushHandle: null, pushPublicKey: null, pushEnvironment: null })
    .where(and(
      eq(schema.mobileDevices.id, deviceId),
      eq(schema.mobileDevices.userId, userId),
      isNull(schema.mobileDevices.revokedAt)
    ))
    .returning();
  return rows[0] || null;
}

// The X25519 public key, 32 bytes. Standard or URL-safe base64 both accepted,
// stored as standard base64.
function parsePublicKey(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) return null;
  const buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === 32 ? buf.toString('base64') : null;
}

function cleanPush(body) {
  const b = body && typeof body === 'object' ? body : {};
  const handle = String(b.handle || '');
  if (!/^sub_[A-Za-z0-9_-]{8,128}$/.test(handle)) throw new MobileError('handle must be a relay subscription handle.');
  // Optional: Android has no extension to decrypt with, so it sends none and is
  // pushed the generic text, reading the real text from the inbox.
  const publicKey = b.publicKey == null || b.publicKey === '' ? null : parsePublicKey(b.publicKey);
  if (b.publicKey != null && b.publicKey !== '' && !publicKey) throw new MobileError('publicKey must be a 32-byte X25519 key in base64.');
  const environment = String(b.environment || '');
  if (!ENVIRONMENTS.includes(environment)) throw new MobileError('environment must be sandbox or production.');
  return { handle, publicKey, environment };
}

async function setPush(deviceId, body) {
  const p = cleanPush(body);
  await db.update(schema.mobileDevices)
    .set({ pushHandle: p.handle, pushPublicKey: p.publicKey, pushEnvironment: p.environment })
    .where(eq(schema.mobileDevices.id, deviceId));
  return p;
}

async function clearPush(deviceId) {
  await db.update(schema.mobileDevices)
    .set({ pushHandle: null, pushPublicKey: null, pushEnvironment: null })
    .where(eq(schema.mobileDevices.id, deviceId));
}

// ── tickets ──────────────────────────────────────────────────────────────────

async function issueTicket({ device, app, path = null }) {
  const ticket = random('amt_');
  await db.insert(schema.mobileTickets).values({
    ticketHash: hash(ticket),
    deviceId: device.id,
    userId: device.userId,
    appId: app.id,
    path,
    expiresAt: new Date(Date.now() + TICKET_TTL_MS)
  });
  return ticket;
}

/**
 * Spend a ticket. Returns { user, app, path }, or throws MobileError with the
 * status to answer. Access is checked here rather than trusted from issue time,
 * because the ticket is the last moment before a session is handed over.
 */
async function redeemTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) throw new MobileError('That link is not valid.', 400);
  const spent = await db.update(schema.mobileTickets).set({ usedAt: new Date() })
    .where(and(eq(schema.mobileTickets.ticketHash, hash(ticket)), isNull(schema.mobileTickets.usedAt)))
    .returning();
  const row = spent[0];
  if (!row) throw new MobileError('That link was already used, or is not valid.', 400);
  if (new Date(row.expiresAt) <= new Date()) throw new MobileError('That link has expired.', 400);

  const [device] = await db.select().from(schema.mobileDevices)
    .where(eq(schema.mobileDevices.id, row.deviceId)).limit(1);
  if (!device || device.revokedAt || new Date(device.expiresAt) <= new Date()) {
    throw new MobileError('This phone has been signed out.', 401);
  }
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!user || !user.isActive) throw new MobileError('That account is not active.', 401);
  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, row.appId)).limit(1);
  if (!app || !app.provisioned) throw new MobileError('That app is not available.', 404);
  if (!hasAccess(user, app)) throw new MobileError('You no longer have access to this app.', 403);
  return { user, app, path: row.path || null };
}

function hasAccess(user, app) {
  const access = Array.isArray(user.appAccess) ? user.appAccess : [];
  return access.includes(app.slug);
}

// ── inbox ────────────────────────────────────────────────────────────────────

async function unreadCount(userId) {
  const [r] = await db.select({ n: count() }).from(schema.userNotifications)
    .where(and(eq(schema.userNotifications.userId, userId), isNull(schema.userNotifications.readAt)));
  return Number(r?.n || 0);
}

async function listNotifications(userId, { before, limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const conds = [eq(schema.userNotifications.userId, userId)];
  if (before) {
    const t = new Date(before);
    if (Number.isNaN(t.getTime())) throw new MobileError('before must be an ISO date.');
    conds.push(lt(schema.userNotifications.createdAt, t));
  }
  const rows = await db.select({
    id: schema.userNotifications.id,
    title: schema.userNotifications.title,
    body: schema.userNotifications.body,
    path: schema.userNotifications.path,
    createdAt: schema.userNotifications.createdAt,
    readAt: schema.userNotifications.readAt,
    appSlug: schema.apps.slug,
    appName: schema.apps.name
  })
    .from(schema.userNotifications)
    .leftJoin(schema.apps, eq(schema.apps.id, schema.userNotifications.appId))
    .where(and(...conds))
    .orderBy(desc(schema.userNotifications.createdAt))
    .limit(n);
  return {
    notifications: rows.map((r) => ({
      id: r.id,
      app: r.appSlug ? { slug: r.appSlug, name: r.appName } : null,
      title: r.title,
      body: r.body,
      path: r.path,
      createdAt: r.createdAt,
      readAt: r.readAt
    })),
    unread: await unreadCount(userId)
  };
}

async function markRead(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return false;
  const rows = await db.select({ id: schema.userNotifications.id }).from(schema.userNotifications)
    .where(and(eq(schema.userNotifications.id, id), eq(schema.userNotifications.userId, userId))).limit(1);
  if (!rows[0]) return false;
  await db.update(schema.userNotifications).set({ readAt: new Date() })
    .where(and(eq(schema.userNotifications.id, id), isNull(schema.userNotifications.readAt)));
  return true;
}

async function markAllRead(userId) {
  await db.update(schema.userNotifications).set({ readAt: new Date() })
    .where(and(eq(schema.userNotifications.userId, userId), isNull(schema.userNotifications.readAt)));
}

// ── cleanup ──────────────────────────────────────────────────────────────────

// Called from the runner's daily prune. Codes and tickets are worthless once
// expired; the inbox keeps 90 days.
async function pruneExpired() {
  const now = new Date();
  await db.delete(schema.mobileCodes).where(lt(schema.mobileCodes.expiresAt, now));
  await db.delete(schema.mobileTickets).where(lt(schema.mobileTickets.expiresAt, now));
  await db.delete(schema.userNotifications)
    .where(lt(schema.userNotifications.createdAt, new Date(now.getTime() - INBOX_DAYS * 864e5)));
}

// The dashboard, for a person who has an operator role.
function adminUrl() {
  if (!config.isConfigured()) return '';
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${config.adminSubdomain}.${config.baseDomain}`;
}

module.exports = {
  REDIRECT_URI, CODE_TTL_MS, TICKET_TTL_MS, DEVICE_IDLE_MS, INBOX_DAYS, PLATFORMS, ENVIRONMENTS,
  MobileError, enabled,
  validChallenge, validVerifier, s256, verifierMatches, validPath, redirectFor, parsePublicKey, cleanPush, cleanDevice,
  issueCode, redeemCode,
  createDevice, authenticate, publicDevice, listDevices, revokeDevice, setPush, clearPush,
  issueTicket, redeemTicket, hasAccess,
  unreadCount, listNotifications, markRead, markAllRead,
  pruneExpired, adminUrl
};
