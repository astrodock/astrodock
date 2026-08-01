'use strict';

// The end-user's session with the PLATFORM, as distinct from their session with
// any one app.
//
// Without this, /authorize served the sign-in form unconditionally: someone using
// three of your apps typed their password three times, and every hop between apps
// looked like being thrown out to a stranger's website. That is the single
// biggest reason hosted sign-in feels like a punch-out.
//
// It is deliberately NOT the operator session (lib/sessions). Those are
// server-side records with revocation and step-up tracking, for people who
// administer the platform. This is a plain signed cookie for people who merely
// use the things it hosts — different population, different lifetime, different
// blast radius. Conflating them would mean an end user's cookie and an owner's
// cookie were the same kind of object.

const jwt = require('jsonwebtoken');
const config = require('../config');

const COOKIE = 'ad_user_session';
const TTL_DAYS = 7;

function key() {
  // Same derivation the Pages session uses: the admin JWT secret is the one
  // secret guaranteed to exist, and these tokens never cross that boundary.
  return config.adminJwtSecret;
}

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name || '' },
    key(),
    { expiresIn: `${TTL_DAYS}d` }
  );
}

function read(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  try { return jwt.verify(raw, key()); } catch { return null; }
}

// SameSite=Lax is required, not incidental: the whole flow is a top-level
// navigation from the app's origin to ours, and Strict would drop the cookie on
// exactly that hop — turning every sign-in back into a password prompt.
function options() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.tlsMode !== 'off',
    maxAge: TTL_DAYS * 864e5,
    path: '/'
  };
}

function set(res, user) { res.cookie(COOKIE, sign(user), options()); }
function clear(res) { res.clearCookie(COOKIE, { path: '/' }); }

module.exports = { COOKIE, TTL_DAYS, sign, read, set, clear, options };
