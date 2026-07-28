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

// The object store is checked through the S3 API, not by asking whether the port
// answers. SeaweedFS returns 200 on a bare GET / whether or not the S3 layer is
// usable, so the old HTTP probe went green for a store that rejected every write:
// wrong credentials, a missing bucket and a healthy store all looked identical.
// ListBuckets exercises signing, credentials and the API in one round trip.
async function probeObjectStore() {
  const { objectstore } = config;
  if (!objectstore.accessKey || !objectstore.secretKey) {
    return { ok: false, error: 'no object-store credentials configured' };
  }
  let client;
  try {
    const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
    client = new S3Client({
      endpoint: objectstore.endpoint,
      region: objectstore.region,
      credentials: { accessKeyId: objectstore.accessKey, secretAccessKey: objectstore.secretKey },
      forcePathStyle: true,
      requestHandler: { requestTimeout: 4000, connectionTimeout: 4000 },
      maxAttempts: 1
    });
    const out = await withTimeout(client.send(new ListBucketsCommand({})), 5000);
    const buckets = (out.Buckets || []).map((b) => b.Name);
    return { ok: true, buckets: buckets.length, hasPlatformBucket: buckets.includes(objectstore.bucket) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { client?.destroy(); } catch { /* ignore */ }
  }
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
    probeObjectStore(),
    probeHttp(`${config.runnerUrl}/health`),
    probeCert()
  ]);
  return { database, objectstore, runner, cert, checkedAt: new Date().toISOString() };
}

// Transition state so we only alert on down→up / up→down edges, not every cycle.
const wasDown = {};
const failStreak = {};
let last = null;

// A dependency has to fail this many probes in a row before it counts as down.
// The api process starts in the same second as its siblings and probes them
// immediately; SeaweedFS and the runner are not listening yet, so a single
// failed probe used to raise a CRITICAL "unreachable" alert on every boot and
// leave the dashboard red for the whole two minutes until the next cycle. The
// dependency was never actually down. Confirming across cycles costs a little
// detection latency and buys an alert that means something.
const FAILURES_BEFORE_DOWN = 2;

async function checkAndAlert() {
  const snap = await probePlatform();
  for (const dep of ['database', 'objectstore', 'runner']) {
    const failing = !snap[dep].ok;
    failStreak[dep] = failing ? (failStreak[dep] || 0) + 1 : 0;
    const down = failStreak[dep] >= FAILURES_BEFORE_DOWN;

    // Report "starting" rather than "unreachable" while a failure is unconfirmed,
    // so the dashboard doesn't accuse a dependency that is merely still booting.
    if (failing && !down) snap[dep].starting = true;

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
  last = snap;
  if (snap.cert && snap.cert.ok && typeof snap.cert.daysLeft === 'number' && snap.cert.daysLeft <= 14) {
    emitEvent({ category: 'system', type: 'system.cert_expiring', severity: 'warning',
      message: `TLS certificate for the admin host expires in ${snap.cert.daysLeft} day(s)`,
      meta: { daysLeft: snap.cert.daysLeft }, dedupeKey: 'system:cert_expiring', dedupeWindowMs: 24 * 3600 * 1000 }).catch(() => {});
  }
  return snap;
}

function getLast() { return last; }

function startPlatformHealth(intervalMs = 120000) {
  // Confirming a failure needs a second probe, so when something looks wrong,
  // come back in seconds rather than waiting out the full cycle — otherwise
  // requiring two failures would push real detection to four minutes.
  const RECHECK_MS = 10000;
  let timer = null;
  const tick = async () => {
    let snap = null;
    try { snap = await checkAndAlert(); } catch { /* keep the loop alive */ }
    const unconfirmed = snap && ['database', 'objectstore', 'runner'].some((d) => snap[d]?.starting);
    timer = setTimeout(tick, unconfirmed ? RECHECK_MS : intervalMs);
    if (timer.unref) timer.unref();
  };
  tick();
}

module.exports = { probePlatform, checkAndAlert, startPlatformHealth, getLast };
