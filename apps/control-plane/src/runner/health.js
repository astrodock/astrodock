'use strict';

const http = require('http');
const os = require('os');
const { execSync } = require('child_process');
const { eq, lt } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { emitEvent } = require('../lib/events');
const { getSetting } = require('../lib/settings');
const { appStatus, pm2List } = require('./process-control');
const { appUrl } = require('../lib/env-compute');

const CHECK_INTERVAL = 60_000;
const FAILURE_THRESHOLD = 3;
const HEALTH_TIMEOUT = 5_000;

const states = new Map();
function getState(slug) {
  if (!states.has(slug)) {
    states.set(slug, { consecutiveFailures: 0, alertSent: false, downSince: null, lastCheck: null, lastStatus: 'unknown', responseTime: null, proc: null });
  }
  return states.get(slug);
}

// Load persisted state on boot so alert/down-since survive a control-plane restart.
async function loadStates() {
  try {
    const rows = await db.select().from(schema.appHealth);
    for (const r of rows) {
      states.set(r.slug, {
        consecutiveFailures: r.consecutiveFailures || 0,
        alertSent: !!r.alertSent,
        downSince: r.downSince || null,
        lastCheck: r.lastCheck ? new Date(r.lastCheck).toISOString() : null,
        lastStatus: r.status || 'unknown',
        responseTime: r.responseTime ?? null,
        proc: r.proc || null
      });
    }
  } catch (err) { console.error('[health] loadStates failed:', err.message); }
}

async function persistState(slug, s) {
  const row = {
    slug, status: s.lastStatus, consecutiveFailures: s.consecutiveFailures,
    downSince: s.downSince ? new Date(s.downSince) : null, alertSent: s.alertSent,
    lastCheck: s.lastCheck ? new Date(s.lastCheck) : null, responseTime: s.responseTime ?? null,
    proc: s.proc || null, updatedAt: new Date()
  };
  try {
    await db.insert(schema.appHealth).values(row)
      .onConflictDoUpdate({ target: schema.appHealth.slug, set: row });
  } catch (err) { console.error('[health] persist failed:', err.message); }
}

function probe(app) {
  return new Promise((resolve) => {
    const host = app.runtimeType === 'docker' ? `app-${app.slug}` : 'localhost';
    const start = Date.now();
    const req = http.get({ host, port: app.port, path: '/health', timeout: HEALTH_TIMEOUT }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: true, responseTime: Date.now() - start }));
    });
    req.on('error', () => resolve({ ok: false, responseTime: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, responseTime: null }); });
  });
}

function downEmail(app, state) {
  return {
    to: config.email.alertTo,
    subject: `[Astrodock] ${app.name} is DOWN`,
    html: `<h2 style="color:#dc2626">App Down</h2><p><strong>${app.name}</strong> (${app.slug}) failed ${state.consecutiveFailures} consecutive health checks.</p><p>URL: ${appUrl(app)}<br>Port: ${app.port}<br>Down since: ${state.downSince ? new Date(state.downSince).toUTCString() : '—'}</p><hr><p style="color:#888;font-size:12px">Astrodock Health Monitor</p>`
  };
}
function recoveryEmail(app, state) {
  const mins = state.downSince ? Math.round((Date.now() - new Date(state.downSince).getTime()) / 60000) : '?';
  return {
    to: config.email.alertTo,
    subject: `[Astrodock] ${app.name} has RECOVERED`,
    html: `<h2 style="color:#0d9668">App Recovered</h2><p><strong>${app.name}</strong> (${app.slug}) is back online after ~${mins} min.</p><p>URL: ${appUrl(app)}</p><hr><p style="color:#888;font-size:12px">Astrodock Health Monitor</p>`
  };
}

// Health transitions flow through the event spine: each records an audit row and
// delivers the attached email (Stage 11 generalizes delivery to configured channels).
function emitDown(app, state) {
  emitEvent({
    category: 'health', type: 'app.down', severity: 'critical',
    appSlug: app.slug, targetType: 'app', targetId: app.slug,
    message: `${app.name} failed ${state.consecutiveFailures} consecutive health checks`,
    meta: { port: app.port, url: appUrl(app), downSince: state.downSince },
    email: downEmail(app, state)
  }).catch(() => {});
}
function emitRecovered(app, state) {
  emitEvent({
    // warning (not info) so it routes alongside the down alert it clears
    category: 'health', type: 'app.recovered', severity: 'warning',
    appSlug: app.slug, targetType: 'app', targetId: app.slug,
    message: `${app.name} recovered`,
    meta: { url: appUrl(app) },
    email: recoveryEmail(app, state)
  }).catch(() => {});
}

async function checkAll() {
  let apps;
  try { apps = await db.select().from(schema.apps).where(eq(schema.apps.provisioned, true)); }
  catch (err) { console.error('[health] fetch apps failed:', err.message); return; }

  const procs = pm2List();
  const active = new Set(apps.map((a) => a.slug));
  for (const slug of states.keys()) if (!active.has(slug)) states.delete(slug);

  for (const app of apps) {
    const state = getState(app.slug);
    state.proc = appStatus(app, procs);
    state.lastCheck = new Date().toISOString();

    if (state.proc && state.proc.status === 'stopped') {
      if (state.alertSent) emitRecovered(app, state);
      Object.assign(state, { lastStatus: 'stopped', consecutiveFailures: 0, alertSent: false, downSince: null, responseTime: null });
      await persistState(app.slug, state);
      continue;
    }

    const result = await probe(app);
    if (result.ok) {
      if (state.alertSent) emitRecovered(app, state);
      Object.assign(state, { consecutiveFailures: 0, alertSent: false, downSince: null, lastStatus: 'healthy', responseTime: result.responseTime });
    } else {
      state.consecutiveFailures++;
      if (state.consecutiveFailures === 1) state.downSince = new Date();
      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.lastStatus = 'down';
        if (!state.alertSent) { emitDown(app, state); state.alertSent = true; }
      } else {
        state.lastStatus = 'degraded';
      }
    }
    await persistState(app.slug, state);
  }
}

function getHealthData() {
  return [...states.entries()].map(([slug, s]) => ({ slug, ...s }));
}

function getServerMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg();
  let disk = { total: '-', used: '-', available: '-', usedPercent: 0 };
  try {
    const parts = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/);
    disk = { total: parts[1] || '-', used: parts[2] || '-', available: parts[3] || '-', usedPercent: parseInt(parts[4], 10) || 0 };
  } catch { /* ignore */ }
  return {
    uptime: os.uptime(),
    memory: { total, free, usedPercent: Math.round(((total - free) / total) * 100) },
    cpu: { load1m: load[0], load5m: load[1], load15m: load[2] },
    disk
  };
}

// Prune auth logs older than the configured retention (default 90 days; Postgres
// has no native TTL). Retention is an operator-editable setting.
async function pruneAuthLogs() {
  const days = await getSetting('logging.auth_log_retention_days', 90);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try { await db.delete(schema.authLogs).where(lt(schema.authLogs.createdAt, cutoff)); }
  catch (err) { console.error('[health] auth-log prune failed:', err.message); }
}

function startHealthChecker() {
  console.log('[health] starting (60s interval)');
  loadStates()
    .then(() => checkAll())
    .catch((e) => console.error('[health] initial check failed:', e.message));
  pruneAuthLogs();
  setInterval(() => checkAll().catch((e) => console.error('[health] cycle failed:', e.message)), CHECK_INTERVAL);
  setInterval(() => pruneAuthLogs(), 24 * 60 * 60 * 1000);
}

module.exports = { startHealthChecker, getHealthData, getServerMetrics };
