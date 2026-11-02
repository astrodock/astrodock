'use strict';

// Which container runs a given compose service in THIS stack?
//
// The names used to be literals (astrodock-postgres-1, astrodock-objectstore-1,
// astrodock-api-1). A second stack on the same host (ASTRODOCK_PROJECT=astrodock2)
// then backed up, restored over, and minted storage keys in the FIRST stack,
// because those are the containers the literals named.
//
// So the runner asks Docker instead: its own container carries the compose project
// label, and every sibling carries the same project plus its service name. The
// updater is a one-shot container outside the project, so it is told the project
// through ASTRODOCK_UPDATE_PROJECT. An explicit env override still wins, and the
// historical name is the last resort.

const { execFileSync } = require('child_process');
const os = require('os');

let project;
const cache = new Map();

function docker(args) {
  return String(execFileSync('docker', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
}

function composeProject() {
  if (project !== undefined) return project;
  project = process.env.ASTRODOCK_UPDATE_PROJECT || null;
  if (!project) {
    try {
      project = docker(['inspect', os.hostname(), '--format', '{{index .Config.Labels "com.docker.compose.project"}}']) || null;
    } catch { project = null; }
  }
  return project;
}

/** The running container for `service` in this compose project, or null. */
function findService(service) {
  if (cache.has(service)) return cache.get(service);
  const p = composeProject();
  if (!p) return null;
  let name = null;
  try {
    const out = docker(['ps', '--filter', `label=com.docker.compose.project=${p}`,
      '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.Names}}']);
    name = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { name = null; }
  // Only a hit is cached: a service that is still starting should be found next time.
  if (name) cache.set(service, name);
  return name;
}

/**
 * Resolve a container name: env override, then the first compose service that
 * exists (in order), then the legacy literal.
 */
function containerFor({ env, services, legacy }) {
  if (env && process.env[env]) return process.env[env];
  for (const s of services) {
    const found = findService(s);
    if (found) return found;
  }
  return legacy;
}

let image;

/**
 * The image this runner was started from: the base for Node apps that run in a
 * container of their own (runner/node-container.js). The same Node, Chromium and
 * system libraries they had under PM2, and already on the box. Holds no secrets:
 * those arrive as environment. ASTRODOCK_APP_BASE_IMAGE overrides.
 */
function selfImage() {
  if (process.env.ASTRODOCK_APP_BASE_IMAGE) return process.env.ASTRODOCK_APP_BASE_IMAGE;
  if (image !== undefined) return image;
  try { image = docker(['inspect', os.hostname(), '--format', '{{.Image}}']) || null; }
  catch { image = null; }
  return image;
}

module.exports = { containerFor, findService, composeProject, selfImage };
