'use strict';

// Process status / control for both compute paths: PM2 (node buildpack apps,
// process name = slug) and Docker (sibling container app-<slug>). Every call is
// defensive — if pm2/docker isn't present (e.g. local dev), returns a safe value
// instead of throwing.

const { execSync } = require('child_process');
const config = require('../config');

function sh(cmd, timeout = 5000) {
  return execSync(cmd, { encoding: 'utf8', timeout });
}

function pm2List() {
  try { return JSON.parse(sh('pm2 jlist 2>/dev/null')); } catch { return []; }
}

function nodeStatus(slug, procs) {
  const p = (procs || pm2List()).find((x) => x.name === slug);
  if (!p) return { status: 'stopped', pid: null, uptime: null, restarts: 0, memory: 0, cpu: 0 };
  return {
    status: p.pm2_env?.status || 'unknown',
    pid: p.pid || null,
    uptime: p.pm2_env?.pm_uptime || null,
    restarts: p.pm2_env?.restart_time || 0,
    memory: p.monit?.memory || 0,
    cpu: p.monit?.cpu || 0
  };
}

function dockerStatus(slug) {
  try {
    const out = sh(`docker inspect app-${slug} --format '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null`).trim();
    const [status, startedAt, restarts] = out.split('|');
    return { status: status === 'running' ? 'online' : (status || 'stopped'), pid: null, uptime: startedAt ? Date.parse(startedAt) : null, restarts: parseInt(restarts, 10) || 0, memory: 0, cpu: 0 };
  } catch {
    return { status: 'stopped', pid: null, uptime: null, restarts: 0, memory: 0, cpu: 0 };
  }
}

function appStatus(app, procs) {
  return app.runtimeType === 'docker' ? dockerStatus(app.slug) : nodeStatus(app.slug, procs);
}

// slug → status string, for all apps (one pm2 jlist call).
function statusAll(apps) {
  const procs = pm2List();
  const out = {};
  for (const app of apps) out[app.slug] = appStatus(app, procs).status;
  return out;
}

function restart(app) {
  if (app.runtimeType === 'docker') sh(`docker restart app-${app.slug} 2>&1`, 15000);
  else sh(`pm2 restart ${app.slug} 2>&1`, 15000);
}

function stop(app) {
  if (app.runtimeType === 'docker') sh(`docker stop app-${app.slug} 2>&1`, 15000);
  else sh(`pm2 stop ${app.slug} 2>&1`, 15000);
}

function stripAnsi(s) { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''); }

function readLogs(app, lines = 100) {
  if (app.runtimeType === 'docker') {
    try { return stripAnsi(sh(`docker logs --tail ${lines} app-${app.slug} 2>&1`, 8000)) || 'No logs available'; }
    catch { return 'No logs available'; }
  }
  const home = process.env.HOME || '/root';
  const all = [];
  for (const f of [`${home}/.pm2/logs/${app.slug}-out.log`, `${home}/.pm2/logs/${app.slug}-error.log`]) {
    try {
      const content = stripAnsi(sh(`tail -n ${lines} "${f}" 2>/dev/null`, 5000));
      for (const ln of content.split('\n')) if (ln.trim()) all.push(ln);
    } catch { /* file may not exist */ }
  }
  all.sort((a, b) => {
    const ta = a.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    const tb = b.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (ta && tb) return ta[1].localeCompare(tb[1]);
    return ta ? -1 : (tb ? 1 : 0);
  });
  return all.slice(-lines).join('\n') || 'No logs available';
}

module.exports = { pm2List, appStatus, statusAll, restart, stop, readLogs, dockerNetwork: config.dockerNetwork };
