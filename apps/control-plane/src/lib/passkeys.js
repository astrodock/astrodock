'use strict';

// WebAuthn / passkeys. Wraps @simplewebauthn/server — hand-rolling this would mean
// parsing CBOR and COSE keys in the authentication path, which is exactly where
// not to be clever.
//
// Two properties we require, both needed for passwordless:
//   • DISCOVERABLE credentials (resident keys) — the authenticator can identify
//     the user without being told who they are, so there is no username step.
//   • USER VERIFICATION — the authenticator confirms it is the right person
//     (biometric or PIN), not merely that someone touched it. Without this a
//     passkey is one factor; with it, it is two.

const { and, eq } = require('drizzle-orm');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const config = require('../config');
const { db, schema } = require('../db');

// Challenges are short-lived and single-use; a table would outlive its usefulness
// before the next request. Keyed by user id (registration) or session id (login).
const challenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function putChallenge(key, value) {
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  challenges.set(key, { value, expires: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(key) {
  const entry = challenges.get(key);
  challenges.delete(key); // one attempt per challenge
  if (!entry || entry.expires < Date.now()) return null;
  return entry.value;
}

/**
 * The Relying Party ID — the host a credential is bound to.
 *
 * Deliberately the ADMIN host, not the base domain: every ceremony happens on the
 * hosted login page, which lives there. Scoping to the base domain would let any
 * app subdomain exercise these credentials, which nothing needs.
 *
 * Consequence worth knowing: the base domain is settable at runtime, so changing
 * it changes the RP ID and INVALIDATES every enrolled passkey. See
 * lib/passkeys.credentialsAtRisk() and the warning on the domain-change path.
 */
function rpId() {
  return `${config.adminSubdomain}.${config.baseDomain}`;
}

function origin() {
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${rpId()}`;
}

function rpName() {
  return 'Astrodock';
}

// ── registration ──────────────────────────────────────────────────────────────

async function beginRegistration(user) {
  const existing = await db.select().from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, user.id));

  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    userName: user.email,
    userDisplayName: user.name || user.email,
    // Do not offer to re-enrol something already here; the browser tells the user.
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports || undefined })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required'
    },
    // We are not auditing authenticator provenance, and asking for attestation
    // costs privacy and compatibility for nothing we would act on.
    attestationType: 'none'
  });

  putChallenge(`reg:${user.id}`, options.challenge);
  return options;
}

async function finishRegistration(user, response, label) {
  const expectedChallenge = takeChallenge(`reg:${user.id}`);
  if (!expectedChallenge) throw new Error('That took too long — start again.');

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpId(),
    requireUserVerification: true
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('That passkey could not be verified.');
  }

  const { credential } = verification.registrationInfo;
  await db.insert(schema.webauthnCredentials).values({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    signCount: credential.counter || 0,
    transports: credential.transports || [],
    label: String(label || '').slice(0, 60) || 'Passkey',
    rpId: rpId()
  });
  return { id: credential.id };
}

// ── authentication ────────────────────────────────────────────────────────────

/**
 * `user` may be null: with discoverable credentials the authenticator tells us who
 * it is, which is what makes usernameless sign-in possible.
 */
async function beginAuthentication({ user = null, handle }) {
  const allow = user
    ? (await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, user.id)))
      .map((c) => ({ id: c.credentialId, transports: c.transports || undefined }))
    : undefined;

  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: allow,
    userVerification: 'required'
  });
  putChallenge(`auth:${handle}`, options.challenge);
  return options;
}

async function finishAuthentication({ handle, response }) {
  const expectedChallenge = takeChallenge(`auth:${handle}`);
  if (!expectedChallenge) throw new Error('That took too long — start again.');

  const rows = await db.select().from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.credentialId, response.id)).limit(1);
  const cred = rows[0];
  if (!cred) throw new Error('Unrecognised passkey.');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpId(),
    requireUserVerification: true,
    credential: {
      id: cred.credentialId,
      publicKey: Buffer.from(cred.publicKey, 'base64url'),
      counter: Number(cred.signCount) || 0,
      transports: cred.transports || undefined
    }
  });
  if (!verification.verified) throw new Error('That passkey could not be verified.');

  // A counter going BACKWARDS means the credential has been cloned. Many
  // authenticators legitimately report a permanent zero — that is allowed, and is
  // why the check is "went backwards", not "did not advance".
  const newCount = verification.authenticationInfo.newCounter;
  const oldCount = Number(cred.signCount) || 0;
  if (oldCount > 0 && newCount > 0 && newCount <= oldCount) {
    throw new Error('This passkey may have been cloned. It has been disabled — please remove and re-add it.');
  }

  await db.update(schema.webauthnCredentials)
    .set({ signCount: newCount, lastUsedAt: new Date() })
    .where(eq(schema.webauthnCredentials.id, cred.id));

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, cred.userId)).limit(1);
  if (!user || !user.isActive) throw new Error('That account is not active.');
  return user;
}

// ── domain changes ────────────────────────────────────────────────────────────

/**
 * Credentials that would stop working if the RP ID changed. Used to warn — never
 * to block, since an enrolled credential should not be able to hold the platform's
 * routing hostage. Password and TOTP survive a domain change untouched.
 */
async function credentialsAtRisk(nextBaseDomain) {
  const nextRpId = `${config.adminSubdomain}.${nextBaseDomain}`;
  const all = await db.select().from(schema.webauthnCredentials);
  const affected = all.filter((c) => (c.rpId || rpId()) !== nextRpId);
  const userIds = [...new Set(affected.map((c) => c.userId))];
  return { count: affected.length, users: userIds.length, currentRpId: rpId(), nextRpId };
}

async function listForUser(userId) {
  return db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, userId));
}

async function remove(userId, id) {
  await db.delete(schema.webauthnCredentials)
    .where(and(eq(schema.webauthnCredentials.id, id), eq(schema.webauthnCredentials.userId, userId)));
}

module.exports = {
  rpId, origin, beginRegistration, finishRegistration,
  beginAuthentication, finishAuthentication,
  credentialsAtRisk, listForUser, remove
};
