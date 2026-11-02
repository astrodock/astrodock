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

const BASE_NAME = 'ad_user_session';
const TTL_DAYS = 7;

// Over HTTPS the name carries the __Host- prefix. A browser refuses any cookie
// with that prefix that names a Domain, so an app on a sibling subdomain cannot
// plant its own session on the auth host and sign a visitor in as someone else.
// Browsers accept the prefix only on Secure cookies, so plain HTTP keeps the
// bare name. Changing it signs everyone out once.
function cookieName() {
  return config.tlsMode !== 'off' ? `__Host-${BASE_NAME}` : BASE_NAME;
}

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
  const raw = req.cookies?.[cookieName()];
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

function set(res, user) { res.cookie(cookieName(), sign(user), options()); }
function clear(res) {
  res.clearCookie(cookieName(), { path: '/', secure: config.tlsMode !== 'off' });
  // A session from before the prefix, so signing out ends that one too.
  if (cookieName() !== BASE_NAME) res.clearCookie(BASE_NAME, { path: '/' });
}

module.exports = {
  get COOKIE() { return cookieName(); },
  TTL_DAYS, sign, read, set, clear, options
};
