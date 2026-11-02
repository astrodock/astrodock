'use strict';

// Which peer may set X-Forwarded-For? Only the reverse proxy named in
// RELAY_TRUST_PROXY (Caddy, when the relay runs as an Astrodock app).
//
// Behind Caddy every request arrives from Caddy's address, so without this
// every device would share one subscription rate limit. Trusting the header
// from anyone would let a caller pick a fresh address per request. The name
// is resolved and refreshed because Docker reassigns Caddy's address when it
// restarts; until the first lookup succeeds, only the socket address is used.

const dns = require('node:dns').promises;
const net = require('node:net');

const REFRESH_MS = 30 * 1000;

function normalize(addr) {
  const a = String(addr || '').toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

function createClientIp(proxyHost) {
  let trusted = new Set();
  let timer = null;

  async function refresh() {
    try {
      const found = await dns.lookup(proxyHost, { all: true });
      trusted = new Set(found.map((f) => normalize(f.address)));
    } catch {
      // Keep the last good answer through a transient DNS failure.
    }
  }

  if (proxyHost) {
    if (net.isIP(proxyHost)) {
      trusted = new Set([normalize(proxyHost)]);
    } else {
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref();
    }
  }

  // The rightmost X-Forwarded-For entry is the one the trusted proxy added.
  function of(req) {
    const peer = normalize(req.socket.remoteAddress);
    const xff = req.headers['x-forwarded-for'];
    if (!xff || !trusted.has(peer)) return peer;
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    return normalize(parts[parts.length - 1]) || peer;
  }

  function close() { if (timer) clearInterval(timer); }

  return { of, close };
}

module.exports = { createClientIp };
