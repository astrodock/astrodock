'use strict';

// Two things every password sign-in needs beyond a per-IP limit.
//
// Failures per account. The per-IP limiters let someone with many addresses
// (or one IPv6 block) keep guessing a single operator's password or TOTP code.
// After MAX failures in WINDOW_MS, that account refuses further attempts until
// the window passes, whoever is asking. Kept in memory: a restart clears it,
// which errs toward letting the real person back in.
//
// Equal time for unknown accounts. Returning before bcrypt when an address has
// no account made "no such account" answer faster than "wrong password", so the
// response time said who has an account. burn() spends the same bcrypt time.

const { hashPassword, verifyPassword } = require('./passwords');

const WINDOW_MS = 15 * 60 * 1000;
const MAX = 10;
const fails = new Map();

function sweep(now) {
  for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
}

function blocked(key) {
  const now = Date.now();
  sweep(now);
  const v = fails.get(key);
  return !!(v && v.n >= MAX);
}

function fail(key) {
  const now = Date.now();
  const v = fails.get(key);
  if (!v || now - v.first > WINDOW_MS) fails.set(key, { n: 1, first: now });
  else v.n += 1;
}

function clear(key) { fails.delete(key); }

let dummy = null;
async function burn(password) {
  if (!dummy) dummy = await hashPassword('astrodock-timing-equalizer');
  await verifyPassword(String(password || ''), dummy).catch(() => false);
}

module.exports = { blocked, fail, clear, burn, MAX, WINDOW_MS };
