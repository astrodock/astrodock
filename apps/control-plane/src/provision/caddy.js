'use strict';

// Generates the full Caddyfile from all apps + the admin host, and pushes it to
// the Caddy admin API (POST /load with the Caddyfile adapter) so reconfiguration
// is atomic and zero-downtime. See DECISIONS.md (B2).

const config = require('../config');

const API = `api:${config.port}`;

// Site address for a host, honoring the TLS mode.
function site(host) {
  return config.tlsMode === 'off' ? `http://${host}` : host;
}

function adminOrigin() {
  // Caddy parses origins with url.Parse, so they MUST include a scheme
  // (a bare "caddy:2019" is read as scheme "caddy"). Match the Origin header
  // the control plane sends (config.caddyAdmin, e.g. http://caddy:2019).
  try { return new URL(config.caddyAdmin).origin; } catch { return 'http://caddy:2019'; }
}

function globalOptions() {
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
  return `{\n${lines.join('\n')}\n}\n`;
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

function nodeAppBlock(app) {
  const host = `${app.subdomain}.${config.baseDomain}`;
  const staticRoot = `${config.paths.caddyStatic}/${app.slug}`;
  return `
${site(host)} {
\thandle /api/* {
\t\treverse_proxy ${API.replace(String(config.port), String(app.port))}
\t}
\thandle {
\t\troot * ${staticRoot}
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
}
`;
}

function dockerAppBlock(app) {
  const host = `${app.subdomain}.${config.baseDomain}`;
  return `
${site(host)} {
\treverse_proxy app-${app.slug}:${app.port}
}
`;
}

/**
 * Build the full Caddyfile text from the given apps (provisioned apps only).
 * Pure function — unit-tested.
 */
function generateCaddyfile(apps) {
  let out = globalOptions();
  out += adminBlock();
  for (const app of apps) {
    out += app.runtimeType === 'docker' ? dockerAppBlock(app) : nodeAppBlock(app);
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
