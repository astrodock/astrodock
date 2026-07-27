'use strict';

// Which docker network should Dockerfile-app containers join?
//
// The answer is "the one the runner is already on" — an app container has to reach
// postgres, the object store and the api by service name, and those are exactly the
// containers sharing the runner's network. So rather than being told the name and
// hoping it stays true, the runner asks Docker what network it is actually on.
//
// This used to be a literal in docker-compose.yml (`astrodock_default`) that had to
// be kept in step with the Compose project name by hand. It silently stopped being
// correct whenever the project was renamed, and every attempt to keep the two in
// sync through configuration just moved the coupling somewhere else. Detection has
// no coupling to keep: it cannot drift, because it reads the truth at the moment it
// is needed.
//
// ASTRODOCK_DOCKER_NETWORK still overrides, for anyone running the runner outside
// Compose or attaching apps to a network of their own.

const { execFile } = require('child_process');
const os = require('os');
const config = require('../config');

let cached = null;

function dockerInspectSelf() {
  return new Promise((resolve) => {
    // Inside a container the hostname IS the short container id, unless someone set
    // hostname: explicitly — in which case inspect resolves it as a name anyway.
    const id = os.hostname();
    execFile(
      'docker',
      ['inspect', id, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const names = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        // A container normally has exactly one. If it somehow has several, prefer a
        // non-default bridge, which is what a Compose network always is.
        resolve(names.find((n) => n !== 'bridge') || names[0] || null);
      }
    );
  });
}

/**
 * Resolve the network name, once per process.
 * Order: explicit override → what Docker says we are on → the historical default.
 */
async function resolveDockerNetwork() {
  if (cached) return cached;
  if (process.env.ASTRODOCK_DOCKER_NETWORK) {
    cached = process.env.ASTRODOCK_DOCKER_NETWORK;
    return cached;
  }
  const detected = await dockerInspectSelf();
  if (detected) {
    cached = detected;
    console.log(`[runner] docker network detected: ${cached}`);
    return cached;
  }
  cached = config.dockerNetwork;
  console.warn(`[runner] could not detect the docker network; falling back to "${cached}". Set ASTRODOCK_DOCKER_NETWORK if app containers cannot reach the platform.`);
  return cached;
}

module.exports = { resolveDockerNetwork };
