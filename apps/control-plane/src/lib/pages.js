'use strict';

// Helpers for the Pages subsystem: id generation, filename validation, content-type
// guessing, the per-page passkey HMAC cookie, and the platform-login session cookie.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

// ── public page id ──
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generatePageId() {
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return s;
}

// ── file names (nested paths allowed; traversal blocked) ──
function validFileName(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes('..')) return false;
  // each path segment: starts alnum, then [A-Za-z0-9._-], ≤128 chars
  return name.split('/').every((seg) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seg));
}

// ── content types ──
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml',
  yml: 'text/yaml; charset=utf-8', yaml: 'text/yaml; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip'
};
const TEXT_EXTS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'csv', 'xml', 'svg', 'yml', 'yaml']);
function ext(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
function contentTypeFor(name) { return TYPES[ext(name)] || 'application/octet-stream'; }
function isTextFile(name) { return TEXT_EXTS.has(ext(name)); }

// ── secrets for cookies (derive a dedicated key; adminJwtSecret is required at boot) ──
function sessionKey() {
  const base = config.secretKey || config.adminJwtSecret || 'astrodock-pages';
  return crypto.createHash('sha256').update(`${base}:pages`).digest('hex');
}

// ── passkey HMAC cookie (scoped to one page; rotating the passkey invalidates it) ──
const PASSKEY_COOKIE = (pageId) => `ad_pk_${pageId}`;
function passkeyToken(pageId, passkey) {
  return crypto.createHmac('sha256', sessionKey()).update(`${pageId}:${passkey}`).digest('base64url');
}
function passkeyValid(pageId, passkey, presented) {
  if (!passkey || !presented) return false;
  const expected = passkeyToken(pageId, passkey);
  const a = Buffer.from(String(presented));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── platform-login session cookie (httpOnly JWT) ──
const SESSION_COOKIE = 'ad_pages_session';
function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, sessionKey(), { expiresIn: '7d' });
}
function verifySession(token) {
  if (!token) return null;
  try { return jwt.verify(token, sessionKey()); } catch { return null; }
}

module.exports = {
  generatePageId, validFileName, contentTypeFor, isTextFile,
  PASSKEY_COOKIE, passkeyToken, passkeyValid,
  SESSION_COOKIE, signSession, verifySession
};
