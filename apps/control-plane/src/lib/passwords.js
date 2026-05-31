'use strict';

const bcrypt = require('bcryptjs');

const ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, verifyPassword, ROUNDS };
