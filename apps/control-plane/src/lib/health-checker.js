const http = require('http');
const os = require('os');
const { execSync } = require('child_process');
const App = require('../models/App');
const { sendEmail } = require('./email');

const CHECK_INTERVAL = 60_000; // 60 seconds
const FAILURE_THRESHOLD = 3;
const HEALTH_TIMEOUT = 5_000; // 5 second timeout per app
const ALERT_TO = process.env.ALERT_EMAIL || 'paul@seniorverse.com';

// In-memory state — resets on process restart
const appStates = new Map();

function getState(slug) {
  if (!appStates.has(slug)) {
    appStates.set(slug, {
      consecutiveFailures: 0,
      alertSent: false,
      downSince: null,
      lastCheck: null,
      lastStatus: 'unknown',
      responseTime: null,
      pm2: null
    });
  }
  return appStates.get(slug);
}

// HTTP health check using Node built-in http module
function checkAppHealth(port) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Try /health first, fall back to /api — any HTTP response means the process is alive
    const req = http.get(`http://localhost:${port}/health`, { timeout: HEALTH_TIMEOUT }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const elapsed = Date.now() - start;
        // Any HTTP response means the server is running and accepting connections
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve({ ok: true, responseTime: elapsed, hasHealthEndpoint: data.status === 'ok' });
          } catch {
            resolve({ ok: true, responseTime: elapsed, hasHealthEndpoint: false });
          }
        } else {
          // Got a response (e.g. 404) — server is alive, just no /health route
          resolve({ ok: true, responseTime: elapsed, hasHealthEndpoint: false });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, responseTime: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, responseTime: null }); });
  });
}

// Get PM2 process list (single call per cycle)
function getPm2Processes() {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function findPm2Process(processes, slug) {
  const pmName = `${slug}-api`;
  const proc = processes.find(p => p.name === pmName);
  if (!proc) return null;
  return {
    status: proc.pm2_env.status,
    memory: proc.monit?.memory || 0,
    cpu: proc.monit?.cpu || 0,
    uptime: proc.pm2_env.pm_uptime,
    restarts: proc.pm2_env.restart_time
  };
}

// Email formatting
function formatDownEmail(app, state) {
  const downSince = state.downSince ? new Date(state.downSince).toUTCString() : 'Unknown';
  const pm2Status = state.pm2?.status || 'unknown';
  return {
    to: ALERT_TO,
    subject: `[SV Platform] ${app.name} is DOWN`,
    html: `
      <h2 style="color: #dc2626; margin: 0 0 16px;">App Down Alert</h2>
      <p><strong>${app.name}</strong> (${app.slug}) has failed ${state.consecutiveFailures} consecutive health checks.</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">URL</td><td>https://${app.subdomain}.seniorverse.dev</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Port</td><td>${app.port}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Down since</td><td>${downSince}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">PM2 status</td><td>${pm2Status}</td></tr>
      </table>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #888; font-size: 12px;">SV Platform Health Monitor</p>
    `
  };
}

function formatRecoveryEmail(app, state) {
  const downSince = state.downSince ? new Date(state.downSince) : null;
  const duration = downSince ? Math.round((Date.now() - downSince.getTime()) / 60000) : '?';
  return {
    to: ALERT_TO,
    subject: `[SV Platform] ${app.name} has RECOVERED`,
    html: `
      <h2 style="color: #0d9668; margin: 0 0 16px;">App Recovered</h2>
      <p><strong>${app.name}</strong> (${app.slug}) is back online.</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">URL</td><td>https://${app.subdomain}.seniorverse.dev</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Downtime</td><td>~${duration} minutes</td></tr>
      </table>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #888; font-size: 12px;">SV Platform Health Monitor</p>
    `
  };
}

async function checkAllApps() {
  let apps;
  try {
    apps = await App.find({ isProvisioned: true });
  } catch (err) {
    console.error('[health] Failed to fetch apps:', err.message);
    return;
  }

  const pm2Processes = getPm2Processes();

  // Remove stale entries for apps that are no longer provisioned
  const activeSlugs = new Set(apps.map(a => a.slug));
  for (const slug of appStates.keys()) {
    if (!activeSlugs.has(slug)) appStates.delete(slug);
  }

  for (const app of apps) {
    const state = getState(app.slug);
    const pm2 = findPm2Process(pm2Processes, app.slug);
    state.pm2 = pm2;
    state.lastCheck = new Date().toISOString();

    // Intentionally stopped — not a failure
    if (pm2 && pm2.status === 'stopped') {
      if (state.alertSent) {
        sendEmail(formatRecoveryEmail(app, state)).catch(() => {});
      }
      state.lastStatus = 'stopped';
      state.consecutiveFailures = 0;
      state.alertSent = false;
      state.downSince = null;
      state.responseTime = null;
      continue;
    }

    const result = await checkAppHealth(app.port);

    if (result.ok) {
      // Recovered — send recovery email if we previously alerted
      if (state.alertSent) {
        sendEmail(formatRecoveryEmail(app, state)).catch(err => {
          console.error(`[health] Recovery email failed for ${app.slug}:`, err.message);
        });
      }
      state.consecutiveFailures = 0;
      state.alertSent = false;
      state.downSince = null;
      state.lastStatus = 'healthy';
      state.responseTime = result.responseTime;
    } else {
      state.consecutiveFailures++;
      state.responseTime = result.responseTime;

      if (state.consecutiveFailures === 1) {
        state.downSince = new Date();
      }

      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.lastStatus = 'down';
        if (!state.alertSent) {
          console.warn(`[health] ${app.slug} is DOWN after ${state.consecutiveFailures} failures`);
          sendEmail(formatDownEmail(app, state)).catch(err => {
            console.error(`[health] Down alert email failed for ${app.slug}:`, err.message);
          });
          state.alertSent = true;
        }
      } else {
        state.lastStatus = 'degraded';
      }
    }
  }
}

function getHealthData() {
  const result = [];
  for (const [slug, state] of appStates) {
    result.push({ slug, ...state });
  }
  return result;
}

function getServerMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const loads = os.loadavg();

  let disk = { total: '-', used: '-', available: '-', usedPercent: 0 };
  try {
    const dfOutput = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 3000 });
    const parts = dfOutput.trim().split(/\s+/);
    // df -h output: Filesystem Size Used Avail Use% Mounted
    disk = {
      total: parts[1] || '-',
      used: parts[2] || '-',
      available: parts[3] || '-',
      usedPercent: parseInt(parts[4]) || 0
    };
  } catch { /* ignore */ }

  return {
    uptime: os.uptime(),
    memory: {
      total: totalMem,
      free: freeMem,
      usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100)
    },
    cpu: {
      load1m: loads[0],
      load5m: loads[1],
      load15m: loads[2]
    },
    disk
  };
}

function startHealthChecker() {
  console.log('[health] Starting health checker (interval: 60s)');
  // Run first check immediately
  checkAllApps().catch(err => console.error('[health] Initial check failed:', err.message));
  setInterval(() => {
    checkAllApps().catch(err => console.error('[health] Check cycle failed:', err.message));
  }, CHECK_INTERVAL);
}

module.exports = { startHealthChecker, getHealthData, getServerMetrics };
