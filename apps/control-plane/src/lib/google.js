'use strict';

// Sign in with Google, for both surfaces: the operator dashboard and the hosted
// login page every app shares. One implementation, because the difference
// between them is only which session gets minted at the end.
//
// What this file is careful about, and why:
//
//   ID TOKEN VERIFIED, NOT DECODED. The token arrives from Google's token
//   endpoint over TLS, but it is still checked properly: RS256 signature
//   against Google's published keys, `iss`, `aud` equal to our client id, and
//   `exp`. A decoded-but-unverified token is a forged login waiting to happen,
//   and the shortcut is one line away, so the reason is written down here.
//
//   LINKED BY `sub`, NOT BY EMAIL. Google's subject id is stable and unique;
//   an email address is neither. Matching on email alone means whoever comes
//   to control an address at Google controls the account here. Email is used
//   once, to find the account a `sub` should attach to, and only when Google
//   says the address is verified.
//
//   `state` AND `nonce` ARE REQUIRED. state is the CSRF defence on the
//   redirect; nonce binds the ID token to the request that asked for it. Both
//   are single-use and short-lived.
//
//   NO 2FA SIGNAL EXISTS. Google's ID token carries no `amr` or `acr` claim, so
//   there is no way to know whether the person used a second factor at Google.
//   Google therefore counts as ONE factor here: it satisfies the primary factor
//   and an account with TOTP configured is still asked for it. Anything else
//   would silently downgrade accounts whose Google side is password-only.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
// Google issues with both spellings; both are legitimate.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Google's signing keys, cached and refreshed on an unseen `kid`.
//
// Done with node's own crypto and the jsonwebtoken already used throughout,
// rather than adding a JOSE dependency: createPublicKey accepts a JWK directly,
// so the whole of "fetch keys, pick by kid, verify RS256" is the twenty lines
// below. Key rotation is handled by refetching once when a kid is unknown,
// which is exactly when Google has rotated.
let keyCache = { at: 0, keys: new Map() };
const KEY_TTL_MS = 60 * 60 * 1000;

async function fetchKeys() {
  const res = await fetch(JWKS_URI);
  if (!res.ok) throw new Error(`could not fetch Google's signing keys (${res.status})`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (!jwk.kid) continue;
    try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
    catch { /* a key we cannot represent is a key we will not verify with */ }
  }
  if (!keys.size) throw new Error("Google's signing keys could not be read");
  keyCache = { at: Date.now(), keys };
  return keys;
}

async function keyFor(kid) {
  const fresh = Date.now() - keyCache.at < KEY_TTL_MS;
  if (fresh && keyCache.keys.has(kid)) return keyCache.keys.get(kid);
  const keys = await fetchKeys();
  const key = keys.get(kid);
  if (!key) throw new Error('the token was signed with a key Google does not publish');
  return key;
}

// ── configuration ────────────────────────────────────────────────────────────

async function settings() {
  const { getSetting } = require('./settings');
  const [clientId, clientSecret, domains] = await Promise.all([
    getSetting('google.client_id', ''),
    getSetting('google.client_secret', ''),
    getSetting('google.allowed_domains', '')
  ]);
  return {
    clientId: String(clientId || '').trim(),
    clientSecret: String(clientSecret || '').trim(),
    // Blank means any Google account. Otherwise a comma-separated allowlist
    // checked against the token's own `hd`/email domain, never a client hint.
    allowedDomains: String(domains || '')
      .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  };
}

async function configured() {
  const s = await settings();
  return !!(s.clientId && s.clientSecret);
}

// ── the round trip ───────────────────────────────────────────────────────────

// Pending sign-ins, keyed by state. In memory on purpose: they live for
// seconds, and a restart mid-sign-in should fail closed rather than resume.
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
}

/**
 * Begin a sign-in. `context` is whatever the caller needs back at the end.
 * `config` is resolved from settings unless supplied, which is how this is
 * tested without a database.
 */
async function begin({ redirectUri, context = {}, loginHint, config }) {
  const { clientId } = config || await settings();
  if (!clientId) throw new Error('Google sign-in is not configured');
  sweep();

  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  pending.set(state, { nonce, redirectUri, context, at: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    // Always show the chooser: silently reusing whichever account the browser
    // happens to be signed into is how people end up in the wrong tenancy.
    prompt: 'select_account'
  });
  if (loginHint) params.set('login_hint', loginHint);
  return { url: `${AUTH_ENDPOINT}?${params}`, state };
}

/** Finish it. Returns the verified identity plus the context passed to begin(). */
async function complete({ code, state, config }) {
  sweep();
  const entry = state && pending.get(state);
  if (!entry) throw new Error('This sign-in expired or was already used. Try again.');
  pending.delete(state);                        // single use, always
  if (!code) throw new Error('Google did not return an authorization code');

  const { clientId, clientSecret, allowedDomains } = config || await settings();
  if (!clientId || !clientSecret) throw new Error('Google sign-in is not configured');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: entry.redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    throw new Error(`Google rejected the sign-in${body.error ? `: ${body.error}` : ''}`);
  }

  // Verified, not decoded. See the header.
  let payload;
  try {
    const header = jwt.decode(body.id_token, { complete: true })?.header;
    if (!header || header.alg !== 'RS256') throw new Error('unexpected token algorithm');
    const key = await keyFor(header.kid);
    payload = jwt.verify(body.id_token, key, {
      algorithms: ['RS256'],          // never trust the token's own alg claim
      issuer: ISSUERS,
      audience: clientId,
      clockTolerance: 60
    });
  } catch (err) {
    throw new Error(`Google's response could not be verified: ${err.message}`);
  }

  if (payload.nonce !== entry.nonce) {
    throw new Error("Google's response did not match this sign-in request");
  }
  // An unverified address is a claim, not a fact, and this one decides which
  // account someone lands in.
  if (payload.email && payload.email_verified !== true) {
    throw new Error('That Google account has an unverified email address');
  }

  const email = String(payload.email || '').toLowerCase();
  const domain = String(payload.hd || email.split('@')[1] || '').toLowerCase();
  if (allowedDomains.length && !allowedDomains.includes(domain)) {
    throw new Error(`Sign-in is limited to ${allowedDomains.join(', ')}`);
  }

  return {
    sub: String(payload.sub),
    email,
    emailVerified: payload.email_verified === true,
    name: String(payload.name || payload.given_name || email.split('@')[0] || ''),
    domain,
    context: entry.context
  };
}

module.exports = { begin, complete, configured, settings, ISSUERS };
