'use strict';

// Bytes in and out of each app's container, per hour (the app_traffic table).
//
// Read from Docker's own counters for the container, so it covers every
// connection the app makes, not just the requests Caddy sees. Only apps in a
// container are counted: PM2 processes share the runner's network and have no
// counters of their own.
//
// The counters reset when a container restarts. A sample that goes backwards,
// or comes from a different container than the last one, is taken as a new
// baseline rather than as negative traffic.
//
// An app that sends more than the configured amount in an hour raises a warning
// event: on a hosted instance, a sudden flood of outbound traffic is the first
// sign of an app sending spam or attacking someone.

const http = require('http');
const { and, eq, lt, sql } = require('drizzle-orm');
const { db, schema } = require('../db');
const { emitEvent } = require('../lib/events');
const { getSetting } = require('../lib/settings');
const { inContainer } = require('../lib/isolation');

const SOCKET = process.env.ASTRODOCK_DOCKER_SOCKET || '/var/run/docker.sock';
const INTERVAL_MS = 60_000;
const last = new Map();

function dockerGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET', timeout: 10000, headers: { Host: 'docker' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Total bytes received and sent across the container's interfaces. */
function totals(stats) {
  let rx = 0;
  let tx = 0;
  for (const n of Object.values((stats && stats.networks) || {})) {
    rx += Number(n.rx_bytes) || 0;
    tx += Number(n.tx_bytes) || 0;
  }
  return { rx, tx };
}

/** The change since the last sample, or zero when this is a new baseline. */
function delta(prev, cur) {
  if (!prev || prev.id !== cur.id || cur.rx < prev.rx || cur.tx < prev.tx) return { rx: 0, tx: 0 };
  return { rx: cur.rx - prev.rx, tx: cur.tx - prev.tx };
}

function hourOf(d = new Date()) {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h;
}

async function record(slug, d) {
  if (!d.rx && !d.tx) return;
  await db.insert(schema.appTraffic).values({ appSlug: slug, hour: hourOf(), rxBytes: d.rx, txBytes: d.tx })
    .onConflictDoUpdate({
      target: [schema.appTraffic.appSlug, schema.appTraffic.hour],
      set: {
        rxBytes: sql`${schema.appTraffic.rxBytes} + ${d.rx}`,
        txBytes: sql`${schema.appTraffic.txBytes} + ${d.tx}`
      }
    });
}

async function checkThreshold(slug) {
  const limitMb = await getSetting('alerts.app_traffic_mb_per_hour', 2048);
  if (!limitMb || limitMb <= 0) return;
  const [row] = await db.select().from(schema.appTraffic)
    .where(and(eq(schema.appTraffic.appSlug, slug), eq(schema.appTraffic.hour, hourOf()))).limit(1);
  if (!row) return;
  const sentMb = Number(row.txBytes) / 1048576;
  if (sentMb < limitMb) return;
  await emitEvent({
    category: 'system', type: 'app.traffic_high', severity: 'warning',
    appSlug: slug, targetType: 'app', targetId: slug,
    message: `${slug} has sent ${Math.round(sentMb)} MB this hour (alert threshold ${limitMb} MB)`,
    meta: { txBytes: Number(row.txBytes), rxBytes: Number(row.rxBytes), thresholdMb: limitMb },
    dedupeKey: `traffic:high:${slug}`, dedupeWindowMs: 6 * 3600 * 1000
  }).catch(() => {});
}

async function sampleAll() {
  let apps;
  try { apps = await db.select().from(schema.apps).where(eq(schema.apps.provisioned, true)); }
  catch { return; }
  for (const app of apps.filter(inContainer)) {
    const stats = await dockerGet(`/containers/app-${app.slug}/stats?stream=false&one-shot=true`);
    if (!stats) continue;
    const cur = { id: stats.id, ...totals(stats) };
    const d = delta(last.get(app.slug), cur);
    last.set(app.slug, cur);
    try {
      await record(app.slug, d);
      if (d.tx) await checkThreshold(app.slug);
    } catch (err) { console.error('[traffic] record failed:', err.message); }
  }
}

async function prune(days = 90) {
  await db.delete(schema.appTraffic).where(lt(schema.appTraffic.hour, new Date(Date.now() - days * 864e5)));
}

function start() {
  setInterval(() => sampleAll().catch((e) => console.error('[traffic] cycle failed:', e.message)), INTERVAL_MS);
  setInterval(() => prune().catch(() => {}), 24 * 3600 * 1000);
}

module.exports = { start, sampleAll, totals, delta, hourOf, prune };
