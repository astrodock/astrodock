'use strict';

// api-side client for the runner service. The control plane never touches the
// Docker socket, the PAT, or PM2 directly — it asks the runner.

const config = require('../config');

function headers(extra = {}) {
  return { Authorization: `Bearer ${config.runnerToken}`, ...extra };
}

async function call(method, path, { json, raw, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const opts = { method, headers: headers() };
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (raw !== undefined) { opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = raw; }
  let res;
  try { res = await fetch(`${config.runnerUrl}${path}${qs}`, opts); }
  catch (err) { const e = new Error(`runner unreachable: ${err.message}`); e.status = 503; throw e; }
  let body = null;
  const text = await res.text();
  if (text) { try { body = JSON.parse(text); } catch { body = { raw: text }; } }
  return { status: res.status, body };
}

// Deploy + process control + storage identity provisioning.
const runner = {
  deploy: (appSlug, opts = {}) => call('POST', '/deploy', { json: { appSlug, ...opts } }),
  deployLocal: (slug, buffer) => call('POST', '/deploy-local', { raw: buffer, query: { slug } }),
  provisionStorage: (appSlug) => call('POST', '/provision-storage', { json: { appSlug } }),
  dropStorage: (appSlug) => call('POST', '/drop-storage', { json: { appSlug } }),
  status: (slug) => call('GET', `/apps/${slug}/status`),
  statusAll: () => call('GET', '/apps/status-all'),
  restart: (slug) => call('POST', `/apps/${slug}/restart`),
  stop: (slug) => call('POST', `/apps/${slug}/stop`),
  remove: (slug) => call('POST', `/apps/${slug}/remove`),
  logs: (slug, lines) => call('GET', `/apps/${slug}/logs`, { query: { lines: lines || 100 } }),
  backup: (trigger = 'manual') => call('POST', '/backup', { json: { trigger } }),
  exposure: () => call('GET', '/exposure'),
  opsList: (slug, p) => call('GET', `/apps/${slug}/ops/list`, { query: { path: p || '.' } }),
  opsFile: (slug, p) => call('GET', `/apps/${slug}/ops/file`, { query: { path: p } }),
  opsEnv: (slug) => call('GET', `/apps/${slug}/ops/env`),
  opsCommands: (slug) => call('GET', `/apps/${slug}/ops/commands`),
  opsRun: (slug, name) => call('POST', `/apps/${slug}/ops/run`, { json: { name } })
};

module.exports = { runner };
