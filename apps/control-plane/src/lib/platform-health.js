'use strict';

// Platform self-health: probe the platform's own dependencies (DB, object store,
// runner) + disk + TLS cert, alert on state transitions, and expose the latest
// snapshot for the operator status view. Runs in the control-plane (api) process,
// which can reach all of them. The app-health monitor (runner/health.js) is separate.

const tls = require('tls');
const config = require('../config');
const { ping } = require('../db');
const { emitEvent } = require('./events');

async function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function probeDb() {
  try { await withTimeout(ping(), 4000); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function probeHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    return { ok: res.status < 500, status: res.status };
  } catch (err) { return { ok: false, error: err.message }; }
}

// Days until the admin host's TLS cert expires (auto TLS only). null = unknown/skipped.
function probeCert() {
  if (config.tlsMode !== 'auto') return Promise.resolve({ ok: true, skipped: true });
  const host = `${config.adminSubdomain}.${config.baseDomain}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tls.connect({ host, port: 443, servername: host, timeout: 4000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return finish({ ok: true, daysLeft: null });
        const daysLeft = Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 864e5);
        finish({ ok: true, daysLeft });
      });
      socket.on('error', (err) => finish({ ok: false, error: err.message }));
      socket.on('timeout', () => { socket.destroy(); finish({ ok: false, error: 'timeout' }); });
    } catch (err) { finish({ ok: false, error: err.message }); }
  });
}

async function probePlatform() {
  const [database, objectstore, runner, cert] = await Promise.all([
    probeDb(),
    probeHttp(config.objectstore.endpoint),
    probeHttp(`${config.runnerUrl}/health`),
    probeCert()
  ]);
  return { database, objectstore, runner, cert, checkedAt: new Date().toISOString() };
}

// Transition state so we only alert on down→up / up→down edges, not every cycle.
const wasDown = {};
let last = null;

async function checkAndAlert() {
  const snap = await probePlatform();
  last = snap;
  for (const dep of ['database', 'objectstore', 'runner']) {
    const down = !snap[dep].ok;
    if (down && !wasDown[dep]) {
      emitEvent({ category: 'system', type: 'system.dependency_down', severity: 'critical',
        message: `Platform dependency "${dep}" is unreachable${snap[dep].error ? `: ${snap[dep].error}` : ''}`,
        meta: { dependency: dep } }).catch(() => {});
    } else if (!down && wasDown[dep]) {
      emitEvent({ category: 'system', type: 'system.dependency_up', severity: 'info',
        message: `Platform dependency "${dep}" recovered`, meta: { dependency: dep } }).catch(() => {});
    }
    wasDown[dep] = down;
  }
  if (snap.cert && snap.cert.ok && typeof snap.cert.daysLeft === 'number' && snap.cert.daysLeft <= 14) {
    emitEvent({ category: 'system', type: 'system.cert_expiring', severity: 'warning',
      message: `TLS certificate for the admin host expires in ${snap.cert.daysLeft} day(s)`,
      meta: { daysLeft: snap.cert.daysLeft }, dedupeKey: 'system:cert_expiring', dedupeWindowMs: 24 * 3600 * 1000 }).catch(() => {});
  }
  return snap;
}

function getLast() { return last; }

function startPlatformHealth(intervalMs = 120000) {
  checkAndAlert().catch(() => {});
  setInterval(() => checkAndAlert().catch(() => {}), intervalMs);
}

module.exports = { probePlatform, checkAndAlert, startPlatformHealth, getLast };
