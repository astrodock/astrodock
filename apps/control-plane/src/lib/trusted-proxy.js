'use strict';

// Which peer may set X-Forwarded-For? Only Caddy.
//
// Caddy's container address is assigned by Docker and changes when it restarts,
// so it is looked up by its compose service name and refreshed. Until the first
// lookup succeeds nothing but loopback is trusted, which means req.ip is the
// socket address: safe, only less precise.

const dns = require('dns').promises;

const HOST = process.env.ASTRODOCK_CADDY_HOST || 'caddy';
const REFRESH_MS = 30 * 1000;

let trusted = new Set();
let timer = null;

function normalize(addr) {
  const a = String(addr || '').toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1';
}

function isTrusted(addr) {
  const a = normalize(addr);
  return isLoopback(a) || trusted.has(a);
}

async function refresh() {
  try {
    const found = await dns.lookup(HOST, { all: true });
    trusted = new Set(found.map((f) => normalize(f.address)));
  } catch {
    // Keep the last good answer: a transient DNS failure should not flip every
    // request to the socket address mid-flight. A Caddy that is gone for good
    // stops matching on its own once the address is reused or the set is replaced.
  }
}

function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
}

// For tests.
function _set(list) { trusted = new Set(list.map(normalize)); }

module.exports = { start, isTrusted, refresh, _set, normalize };
