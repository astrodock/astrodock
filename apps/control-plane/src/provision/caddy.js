'use strict';

// Generates the full Caddyfile from all apps + the admin host, and pushes it to
// the Caddy admin API (POST /load with the Caddyfile adapter) so reconfiguration
// is atomic and zero-downtime. See DECISIONS.md (B2).

const config = require('../config');

const API = `api:${config.port}`;
// Node buildpack apps run as PM2 processes INSIDE the runner container, so their
// /api/* traffic must be proxied to the runner (not the control-plane api).
function runnerHost() {
  try { return new URL(config.runnerUrl).hostname; } catch { return 'runner'; }
}

// Site address for a host, honoring the TLS mode.
function site(host) {
  return config.tlsMode === 'off' ? `http://${host}` : host;
}

// Per-app JSON access log (opt-in via the logging.app_access_logs setting). The
// control plane reads these files back from a shared volume. Returns '' when off.
const CADDY_LOG_DIR = '/var/log/caddy';
function appLog(app, accessLogs) {
  if (!accessLogs) return '';
  return `\tlog {\n\t\toutput file ${CADDY_LOG_DIR}/${app.slug}.log {\n\t\t\troll_size 10MiB\n\t\t\troll_keep 3\n\t\t}\n\t\tformat json\n\t}\n`;
}

function adminOrigin() {
  // Caddy parses origins with url.Parse, so they MUST include a scheme
  // (a bare "caddy:2019" is read as scheme "caddy"). Match the Origin header
  // the control plane sends (config.caddyAdmin, e.g. http://caddy:2019).
  try { return new URL(config.caddyAdmin).origin; } catch { return 'http://caddy:2019'; }
}

function askUrl() {
  return `${config.internalAuthUrl}/_caddy/ask`;
}

function globalOptions(onDemand) {
  // Keep the admin API reachable from the api container; the origins list must
  // include the Origin the control plane POSTs from, or Caddy returns 403.
  const lines = [
    '\tadmin 0.0.0.0:2019 {',
    `\t\torigins ${adminOrigin()} http://localhost:2019 http://127.0.0.1:2019`,
    '\t}'
  ];
  if (config.tlsMode === 'auto' && config.acmeEmail) lines.push(`\temail ${config.acmeEmail}`);
  if (config.tlsMode === 'internal') lines.push('\tlocal_certs');
  if (config.tlsMode === 'off') lines.push('\tauto_https off');
  // On-demand TLS for custom domains: Caddy asks us before issuing a cert, so it
  // only issues for hostnames we've registered + verified (no abuse, no preprovision).
  if (onDemand) lines.push(`\ton_demand_tls {\n\t\task ${askUrl()}\n\t}`);
  return `{\n${lines.join('\n')}\n}\n`;
}

// A custom domain mirrors its app's routing, keyed on the external hostname.
function customDomainBlock(d, accessLogs, onDemand) {
  const host = d.hostname;
  const tlsLine = onDemand ? '\ttls {\n\t\ton_demand\n\t}\n' : '';
  const logLine = appLog({ slug: d.appSlug }, accessLogs);
  if (d.runtimeType === 'docker') {
    return `\n${site(host)} {\n${tlsLine}${logLine}\treverse_proxy app-${d.appSlug}:${d.port}\n}\n`;
  }
  const staticRoot = `${config.paths.caddyStatic}/${d.appSlug}`;
  return `\n${site(host)} {\n${tlsLine}${logLine}\thandle /api/* {\n\t\treverse_proxy ${runnerHost()}:${d.port}\n\t}\n\thandle {\n\t\troot * ${staticRoot}\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n}\n`;
}

function adminBlock() {
  const host = `${config.adminSubdomain}.${config.baseDomain}`;
  const staticRoot = `${config.paths.caddyStatic}/__admin`;
  return `
${site(host)} {
\thandle /admin/* {
\t\treverse_proxy ${API}
\t}
\thandle /verify {
\t\treverse_proxy ${API}
\t}
\thandle /webhooks/* {
\t\treverse_proxy ${API}
\t}
\thandle /health {
\t\treverse_proxy ${API}
\t}
\thandle /account* {
\t\treverse_proxy ${API}
\t}
\thandle {
\t\troot * ${staticRoot}
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
}
`;
}

function nodeAppBlock(app, accessLogs) {
  const host = `${app.subdomain}.${config.baseDomain}`;
  const staticRoot = `${config.paths.caddyStatic}/${app.slug}`;
  return `
${site(host)} {
${appLog(app, accessLogs)}\thandle /api/* {
\t\treverse_proxy ${runnerHost()}:${app.port}
\t}
\thandle {
\t\troot * ${staticRoot}
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
}
`;
}

function dockerAppBlock(app, accessLogs) {
  const host = `${app.subdomain}.${config.baseDomain}`;
  return `
${site(host)} {
${appLog(app, accessLogs)}\treverse_proxy app-${app.slug}:${app.port}
}
`;
}

/**
 * Build the full Caddyfile text from the given apps (provisioned apps only).
 * Pure function — unit-tested.
 */
// The pages.<base-domain> host — all paths proxied to the control plane, which serves
// page files, applies the access gate, and rejects /admin/* on this host.
function pagesBlock() {
  const host = `${config.pages.subdomain}.${config.baseDomain}`;
  return `
${site(host)} {
\treverse_proxy ${API}
}
`;
}

function generateCaddyfile(apps, opts = {}) {
  const accessLogs = !!opts.accessLogs;
  const domains = opts.domains || [];
  const onDemand = config.tlsMode === 'auto' && domains.length > 0;
  let out = globalOptions(onDemand);
  out += adminBlock();
  out += pagesBlock();
  for (const app of apps) {
    out += app.runtimeType === 'docker' ? dockerAppBlock(app, accessLogs) : nodeAppBlock(app, accessLogs);
  }
  for (const d of domains) {
    out += customDomainBlock(d, accessLogs, onDemand);
  }
  return out;
}

/**
 * Push a Caddyfile to the running Caddy via the admin API. Best-effort: logs and
 * returns false on failure (so a missing/booting Caddy never crashes a deploy).
 */
async function loadCaddyfile(text) {
  try {
    const res = await fetch(`${config.caddyAdmin}/load`, {
      method: 'POST',
      // Caddy's admin API enforces an Origin check on non-loopback binds; send one it allows.
      headers: { 'Content-Type': 'text/caddyfile', Origin: config.caddyAdmin },
      body: text
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[caddy] reload failed ${res.status}: ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[caddy] reload error:', err.message);
    return false;
  }
}

module.exports = { generateCaddyfile, loadCaddyfile, API };
