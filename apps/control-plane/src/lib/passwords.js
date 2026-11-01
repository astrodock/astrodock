'use strict';

const bcrypt = require('bcryptjs');

const ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

// bcryptjs rejects on a missing hash or a non-string password, and an unhandled
// rejection takes the process down. An account with no password, or a request
// with no password, is simply not a match.
async function verifyPassword(plain, hash) {
  if (!hash || typeof hash !== 'string') return false;
  if (plain === undefined || plain === null) return false;
  return bcrypt.compare(String(plain), hash);
}

module.exports = { hashPassword, verifyPassword, ROUNDS };
