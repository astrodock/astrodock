'use strict';

// Where an app's process lives, and the caps on it.
//
// Dockerfile apps always run in a container of their own. Node buildpack apps
// run either under PM2 inside the runner (the original model) or, with
// ASTRODOCK_NODE_RUNTIME=container, in a container of their own built from the
// platform image (runner/node-container.js). `apps.node_isolation` records which
// one the last successful deploy used, so routing and status follow what is
// actually running rather than what the next deploy will do.
//
// Caps apply only to containers. PM2 has no CPU cap, and its memory option
// restarts a process rather than limiting it.

const config = require('../config');

function inContainer(app) {
  return app.runtimeType === 'docker' || app.nodeIsolation === 'container';
}

function containerName(app) {
  return `app-${app.slug}`;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/** The caps that apply to this app: its own values, else the platform's. */
function limitsFor(app) {
  const l = config.limits;
  const memoryMb = clamp(Number.isFinite(app.memoryMb) && app.memoryMb > 0 ? app.memoryMb : l.memoryMbDefault, 64, l.memoryMbMax);
  const cpuMillis = clamp(Number.isFinite(app.cpuMillis) && app.cpuMillis > 0 ? app.cpuMillis : l.cpuMillisDefault, 100, l.cpuMillisMax);
  return {
    memoryMb,
    cpuMillis,
    custom: { memory: Number.isFinite(app.memoryMb) && app.memoryMb > 0, cpu: Number.isFinite(app.cpuMillis) && app.cpuMillis > 0 },
    max: { memoryMb: l.memoryMbMax, cpuMillis: l.cpuMillisMax }
  };
}

/** `docker run` / `docker update` arguments for those caps. Swap equals memory: no swap. */
function dockerLimitArgs(app) {
  const { memoryMb, cpuMillis } = limitsFor(app);
  return ['--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`, '--cpus', (cpuMillis / 1000).toFixed(2)];
}

/** Validate a cap someone typed. Null clears it back to the default. */
function parseLimit(value, { min, max, label }) {
  if (value === null || value === '' || value === undefined) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== String(value).trim()) throw new Error(`${label} must be a whole number.`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

module.exports = { inContainer, containerName, limitsFor, dockerLimitArgs, parseLimit };
