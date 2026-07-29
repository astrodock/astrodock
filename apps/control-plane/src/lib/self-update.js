'use strict';

// Updating Astrodock from the dashboard.
//
// The hard part is not pulling an image, it is that the process doing the update
// gets replaced by the update. `docker compose up -d` recreates the api and the
// runner, so whichever of them ran the command is killed partway through and
// nothing is left to notice whether it worked, let alone roll back.
//
// So the work happens in a ONE-SHOT CONTAINER that is not part of the compose
// project: it starts, does everything, records the outcome in the database, and
// exits. Compose can freely tear down and rebuild the stack underneath it.
//
// That container runs from the image Astrodock is ALREADY running — no pull, no
// dependency on a registry being reachable at the moment someone asks for an
// update. The compose plugin is baked in for the same reason.
//
// Nothing here needs a change to docker-compose.yml, which matters: the compose
// file lives on the operator's disk and a `docker compose pull` never refreshes
// it. Anything that required editing it would mean an update feature you have to
// install by hand. The project directory is discovered instead, from the labels
// Compose puts on its own containers.

const { execFile } = require('child_process');
const os = require('os');
const config = require('../config');
const version = require('./version');

function docker(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

// Everything needed to drive compose, read off this container. Compose stamps the
// project name, the working directory and the config files onto every container
// it creates, so an install can describe itself without being told anything.
async function describe() {
  const out = { version: version.resolve(), ok: false, reason: null };
  let labels;
  try {
    const raw = await docker(['inspect', os.hostname(), '--format', '{{json .Config.Labels}}']);
    labels = JSON.parse(raw);
  } catch (err) {
    out.reason = `Cannot reach the Docker socket from here: ${err.message}`;
    return out;
  }

  return { ...out, ...classify(labels) };
}

// Whether this install can be updated from the dashboard, decided purely from
// the labels Compose stamps on its containers. Split out so the decision can be
// tested against real label shapes rather than only by standing up a stack.
function classify(labels) {
  const out = {
    project: labels['com.docker.compose.project'] || null,
    workingDir: labels['com.docker.compose.project.working_dir'] || null,
    configFiles: (labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean),
    service: labels['com.docker.compose.service'] || null,
    ok: false,
    reason: null
  };

  if (!out.project || !out.workingDir) {
    out.reason = 'This install was not started by Docker Compose, so Astrodock cannot update it for you.';
    return out;
  }
  // A source build has no published image to pull; `compose up` would try to
  // rebuild from a tree this container cannot see.
  if (out.configFiles.some((f) => /docker-compose\.build\.ya?ml$/.test(f.trim()))) {
    out.reason = 'This install builds its images from source, so there is no published image to pull. Update it with git pull and a rebuild.';
    return out;
  }
  out.ok = true;
  return out;
}

// Launch the updater and return immediately. Detached on purpose: this process is
// about to be replaced, and waiting for a result it will not survive to read is
// worse than not waiting.
async function launch({ toVersion, actor, currentVersion }) {
  const info = await describe();
  if (!info.ok) { const e = new Error(info.reason); e.status = 409; throw e; }

  const network = await require('../runner/network').resolveDockerNetwork().catch(() => null);
  const self = await docker(['inspect', os.hostname(), '--format', '{{.Config.Image}}']);

  const args = [
    'run', '--detach', '--rm',
    '--name', `astrodock-updater-${Date.now().toString(36)}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${info.workingDir}:/project`,
    '-e', `ASTRODOCK_UPDATE_TO=${toVersion || ''}`,
    '-e', `ASTRODOCK_UPDATE_FROM=${currentVersion || ''}`,
    '-e', `ASTRODOCK_UPDATE_ACTOR=${actor || ''}`,
    '-e', `ASTRODOCK_UPDATE_PROJECT=${info.project}`
  ];
  // The updater has to reach Postgres to record what happened and the api to
  // health-check it, both by service name.
  if (network) args.push('--network', network);
  // Same database and secrets as this process — it is the same platform.
  for (const k of ['ASTRODOCK_PG_HOST', 'ASTRODOCK_PG_PORT', 'ASTRODOCK_PG_USER',
    'ASTRODOCK_PG_PASSWORD', 'ASTRODOCK_PG_DATABASE', 'ASTRODOCK_SECRET_KEY']) {
    if (process.env[k] != null) args.push('-e', `${k}=${process.env[k]}`);
  }
  args.push('--workdir', '/app/apps/control-plane', '--entrypoint', 'node',
    self, 'src/runner/update-worker.js');

  const id = await docker(args, { timeout: 30000 });
  return { started: true, containerId: id.slice(0, 12), from: currentVersion, to: toVersion || 'latest' };
}

module.exports = { describe, launch, classify };
