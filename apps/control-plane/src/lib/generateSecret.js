const crypto = require('crypto');

function generateAppSecret() {
  return 'sk_' + crypto.randomBytes(32).toString('hex');
}

module.exports = { generateAppSecret };
