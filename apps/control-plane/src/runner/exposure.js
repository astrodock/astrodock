'use strict';

// What is this box actually exposing to the internet?
//
// Deliberately a CHECK, not a firewall. Astrodock does not manage ufw/iptables,
// for two reasons worth writing down so nobody "fixes" this later:
//
//   1. Docker publishes ports by inserting its own iptables rules ahead of ufw's
//      chains, so `ufw deny 5432` does NOT block a container published on 5432.
//      A firewall feature built the obvious way would report protection it isn't
//      providing — worse than no feature at all.
//   2. The platform is reachable only through the ports it would be managing. A
//      bug in that code locks the operator out of the very interface they'd use
//      to undo it, on a remote box, with no console.
//
// So: report precisely, let the operator act. A published port bound to 0.0.0.0
// (or ::) is reachable from anywhere the network allows; one bound to 127.0.0.1
// is not. Only 80 and 443 are expected to be public.

const { execFile } = require('child_process');

const EXPECTED_PUBLIC = new Set(['80', '443']);
const DOCKER_TIMEOUT_MS = 5000;

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });
}

// `docker ps` renders published ports like:
//   0.0.0.0:443->443/tcp, [::]:443->443/tcp, 127.0.0.1:5432->5432/tcp, 8333/tcp
// The last form (no "->") is container-internal and never reachable from outside.
function parsePorts(portsField) {
  const out = [];
  for (const partRaw of String(portsField || '').split(',')) {
    const part = partRaw.trim();
    if (!part || !part.includes('->')) continue;
    const m = part.match(/^(\[[^\]]+\]|[^:]+):(\d+)->(\d+)\/(\w+)$/);
    if (!m) continue;
    const [, bindRaw, hostPort, containerPort, proto] = m;
    const bind = bindRaw.replace(/^\[|\]$/g, '');
    const publicly = bind === '0.0.0.0' || bind === '::' || bind === '';
    out.push({ bind, hostPort, containerPort, proto, public: publicly });
  }
  return out;
}

/**
 * Inspect every running container's published ports.
 * Returns { available, ports, findings } — `available:false` means we could not
 * ask Docker, which is reported as unknown rather than as "safe".
 */
async function checkExposure() {
  let stdout;
  try {
    stdout = await docker(['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  } catch (err) {
    return { available: false, reason: err.message, ports: [], findings: [] };
  }

  const ports = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, portsField] = line.split('\t');
    for (const p of parsePorts(portsField)) ports.push({ container: name, ...p });
  }

  // Dedupe by host port + protocol: the same port shows up once for IPv4 and
  // again for IPv6, which would otherwise read as two separate problems.
  const seen = new Set();
  const findings = [];
  for (const p of ports) {
    if (!p.public) continue;
    if (EXPECTED_PUBLIC.has(p.hostPort)) continue;
    const key = `${p.hostPort}/${p.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      port: p.hostPort,
      proto: p.proto,
      container: p.container,
      message: `Port ${p.hostPort}/${p.proto} (${p.container}) is published on all interfaces. Only 80 and 443 need to be reachable from the internet.`
    });
  }

  return { available: true, ports, findings };
}

module.exports = { checkExposure, parsePorts, EXPECTED_PUBLIC };
