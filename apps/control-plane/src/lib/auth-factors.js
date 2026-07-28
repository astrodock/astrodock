'use strict';

// The factors an account can authenticate with, and the rules that stop someone
// removing the last one. See AUTH_DESIGN.md.
//
// The invariant enforced here is the whole reason this file exists:
//
//   AN ACCOUNT MUST ALWAYS RETAIN AT LEAST ONE USABLE PRIMARY FACTOR.
//
// Recovery codes do not count — they are single-use and exhaustible, so an account
// holding only recovery codes is one bad day from being unreachable. Every
// violation of this is a lockout with no remedy short of editing the database by
// hand, which is why it lives in the data layer rather than only in the UI.

const crypto = require('crypto');
const { and, eq, isNull } = require('drizzle-orm');
const { db, schema } = require('../db');
const { hashPassword, verifyPassword } = require('./passwords');
const { encryptSecret, decryptSecret } = require('./crypto');
const totp = require('./totp');

const RECOVERY_CODE_COUNT = 10;
// Length alone is a weak signal, and a high floor pushes people toward reuse and
// sticky notes. Passkeys and TOTP are where the real protection comes from.
const MIN_PASSWORD_LENGTH = 8;

// ── inventory ─────────────────────────────────────────────────────────────────

/** What can this account actually sign in with right now? */
async function factorsFor(userId) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) throw new Error('User not found');
  const creds = await db.select().from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId));
  const unusedCodes = await db.select().from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)));
  return {
    password: !!u.passwordHash,
    passkeys: creds.length,
    passkeyList: creds,
    totp: !!(u.totpSecret && u.totpConfirmedAt),
    recoveryCodesRemaining: unusedCodes.length,
    passwordless: !!u.passwordless
  };
}

/** Primary factors only. Recovery codes deliberately excluded. */
function primaryFactorCount(f) {
  return (f.password ? 1 : 0) + (f.passkeys > 0 ? 1 : 0);
}

/**
 * Would `change` leave this account unable to sign in?
 * `change` is one of: removePassword, removePasskey, addPassword, addPasskey.
 */
async function assertStillReachable(userId, change) {
  const f = await factorsFor(userId);
  const after = {
    password: change === 'removePassword' ? false : (change === 'addPassword' ? true : f.password),
    passkeys: change === 'removePasskey' ? f.passkeys - 1 : (change === 'addPasskey' ? f.passkeys + 1 : f.passkeys)
  };
  if (primaryFactorCount(after) < 1) {
    throw new Error(
      change === 'removePassword'
        ? 'You would have no way to sign in. Add a passkey before removing your password.'
        : 'That is your only way to sign in. Set a password before removing your last passkey.'
    );
  }
  return f;
}

/** A second factor exists (for MFA-required policy checks). */
function hasSecondFactor(f) {
  // A passkey with user verification is itself two factors — something you have
  // plus something you are — so it satisfies the requirement on its own.
  return f.totp || f.passkeys > 0;
}

// ── passwords ─────────────────────────────────────────────────────────────────

async function setPassword(userId, plain) {
  if (!plain || String(plain).length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(String(plain));
  await db.update(schema.users).set({ passwordHash, passwordless: false, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}

async function removePassword(userId) {
  await assertStillReachable(userId, 'removePassword');
  await db.update(schema.users).set({ passwordHash: null, passwordless: true, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}

async function checkPassword(user, plain) {
  // An account with no password cannot be signed into with one. Returning false
  // rather than throwing keeps the caller's error message uniform, so this does
  // not become an oracle for which accounts are passwordless.
  if (!user.passwordHash) return false;
  return verifyPassword(String(plain || ''), user.passwordHash);
}

// ── TOTP ──────────────────────────────────────────────────────────────────────

/** Begin enrolment. Nothing is switched on until a code is confirmed. */
async function beginTotp(userId, accountLabel) {
  const secret = totp.generateSecret();
  await db.update(schema.users)
    .set({ totpSecret: encryptSecret(secret), totpConfirmedAt: null, totpLastStep: null, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return { secret, uri: totp.provisioningUri({ secret, account: accountLabel }) };
}

/** Finish enrolment — requires a working code, so nobody locks in a bad QR scan. */
async function confirmTotp(userId, code) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u || !u.totpSecret) throw new Error('Start setting up your authenticator app first.');
  const secret = decryptSecret(u.totpSecret);
  const res = totp.verify(secret, code, { lastStep: u.totpLastStep });
  if (!res.ok) throw new Error('That code is not right. Check your authenticator app and try again.');
  await db.update(schema.users)
    .set({ totpConfirmedAt: new Date(), totpLastStep: res.step, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return true;
}

async function checkTotp(user, code) {
  if (!user.totpSecret || !user.totpConfirmedAt) return false;
  const res = totp.verify(decryptSecret(user.totpSecret), code, { lastStep: user.totpLastStep });
  if (!res.ok) return false;
  // Persist the spent step so the same code cannot be used twice inside its window.
  await db.update(schema.users).set({ totpLastStep: res.step }).where(eq(schema.users.id, user.id));
  return true;
}

async function removeTotp(userId) {
  await db.update(schema.users)
    .set({ totpSecret: null, totpConfirmedAt: null, totpLastStep: null, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}

// ── recovery codes ────────────────────────────────────────────────────────────

function formatCode(raw) {
  // Grouped for transcription; comparison strips the separator.
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

function normalizeCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Replaces any existing set — regenerating invalidates the old codes. */
async function generateRecoveryCodes(userId) {
  await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
  const plain = [];
  const rows = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // 10 chars of base32-ish alphabet, ambiguous characters removed.
    const raw = crypto.randomBytes(10).toString('base64url').replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase().replace(/[oil01]/g, 'x').slice(0, 10).padEnd(10, 'x');
    plain.push(formatCode(raw));
    rows.push({ userId, codeHash: await hashPassword(raw) });
  }
  await db.insert(schema.recoveryCodes).values(rows);
  return plain;
}

/** Single use: a matching code is marked spent before this returns true. */
async function consumeRecoveryCode(userId, submitted) {
  const candidate = normalizeCode(submitted);
  if (!candidate) return false;
  const rows = await db.select().from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)));
  for (const row of rows) {
    if (await verifyPassword(candidate, row.codeHash)) {
      await db.update(schema.recoveryCodes).set({ usedAt: new Date() })
        .where(eq(schema.recoveryCodes.id, row.id));
      return true;
    }
  }
  return false;
}

module.exports = {
  factorsFor, primaryFactorCount, assertStillReachable, hasSecondFactor,
  setPassword, removePassword, checkPassword,
  beginTotp, confirmTotp, checkTotp, removeTotp,
  generateRecoveryCodes, consumeRecoveryCode,
  RECOVERY_CODE_COUNT, MIN_PASSWORD_LENGTH
};
