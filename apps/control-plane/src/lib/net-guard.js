'use strict';

// Outbound requests to URLs someone else chose (notification webhooks, an app's
// feedback webhook) must not reach inside the perimeter.
//
// The control plane sits on the compose network, where `postgres`, `objectstore`,
// `runner` and `caddy` answer to their service names, and on a cloud VM the
// metadata service answers at 169.254.169.254. Checking the hostname string is not
// enough: a public name can resolve to a private address, and a public endpoint
// can redirect to one. So the address is checked AFTER resolution, inside the
// socket's own lookup (the connection goes to exactly the address that was
// checked, so a second DNS answer cannot swap it), and redirects are not followed.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]
]) blocked.addSubnet(addr, prefix, 'ipv6');

// ::ffff:a.b.c.d and ::ffff:7f00:1 are IPv4 addresses wearing IPv6 clothes.
function mappedV4(addr) {
  const m = /^::ffff:(.+)$/i.exec(addr);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** Is this literal IP address one an outbound request may connect to? */
function isPublicAddress(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '');
  const v4 = net.isIPv4(a) ? a : mappedV4(a);
  if (v4) return !blocked.check(v4, 'ipv4');
  if (net.isIPv6(a)) return !blocked.check(a, 'ipv6');
  return false;
}

/** A hostname that can only mean something inside the network. */
function isInternalName(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // A bare name with no dot is a container or a search-domain lookup, never a
  // public endpoint.
  return !h.includes('.');
}

// Escape hatch for an operator who really does send alerts to something on their
// own LAN. Off unless set.
const allowPrivate = () => process.env.ASTRODOCK_WEBHOOK_ALLOW_PRIVATE === '1';

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = allowPrivate() ? list : list.filter((e) => isPublicAddress(e.address));
    if (!ok.length) {
      const e = new Error('destination is not a public address');
      e.code = 'EBLOCKED';
      return cb(e);
    }
    if (options && options.all) return cb(null, ok);
    return cb(null, ok[0].address, ok[0].family);
  });
}

/** Can this URL be posted to at all? A cheap check before any DNS. */
function checkUrl(value, { httpsOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) {
    return { ok: false, reason: httpsOnly ? 'must be https' : 'must be http(s)' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  if (!allowPrivate()) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isInternalName(host)) return { ok: false, reason: 'destination is not a public address' };
    if (net.isIP(host) && !isPublicAddress(host)) return { ok: false, reason: 'destination is not a public address' };
  }
  return { ok: true, url };
}

/**
 * POST JSON to a URL someone else chose. Resolves to { ok, status } and never
 * throws. A redirect is a failure: following it is how a public URL reaches a
 * private one.
 */
function postJson(value, payload, { timeoutMs = 8000, httpsOnly = false } = {}) {
  const checked = checkUrl(value, { httpsOnly });
  if (!checked.ok) return Promise.resolve({ ok: false, status: 0, reason: checked.reason });
  const url = checked.url;
  const body = Buffer.from(JSON.stringify(payload));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'User-Agent': 'Astrodock' },
      lookup: guardedLookup,
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      const status = res.statusCode || 0;
      if (status >= 200 && status < 300) return resolve({ ok: true, status });
      resolve({ ok: false, status, reason: status >= 300 && status < 400 ? 'redirects are not followed' : `HTTP ${status}` });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({
      ok: false, status: 0, reason: err.code === 'EBLOCKED' ? 'destination is not a public address' : 'could not connect'
    }));
    req.end(body);
  });
}

module.exports = { isPublicAddress, isInternalName, checkUrl, postJson };
