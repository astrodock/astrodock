'use strict';

// The server itself: what the disk holds, freeing space, and running a command
// as root on the host.
//
// Runs in the runner, which holds the Docker socket. That socket is already
// root-equivalent on the host (see SECURITY.md), so the server terminal adds a
// convenience, not a privilege: it starts a short-lived container that enters
// the host's namespaces with nsenter and runs the command there, exactly as an
// operator would over SSH.
//
// The control plane decides who may call these (the `server:exec` permission,
// which only the owner role and owner-minted 24-hour keys hold) and records
// every command in the audit trail before it runs.

const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { tagsToRemove, appTagsToRemove } = require('../lib/images');

const EXEC_TIMEOUT_MS = 15 * 60 * 1000; // long enough for an apt upgrade
const PLATFORM_IMAGE = () => process.env.ASTRODOCK_IMAGE || 'ghcr.io/astrodock/astrodock';

function docker(args, { timeout = 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 2000)));
      resolve(String(stdout || '').trim());
    });
  });
}

function sh(cmd, { timeout = 15 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', cmd], { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

/** On unless the operator has switched it off in .env. */
function terminalEnabled() {
  return String(process.env.ASTRODOCK_SERVER_TERMINAL || '').toLowerCase() !== 'off';
}

// ── disk ──────────────────────────────────────────────────────────────────────

// `df /` inside this container reports the host disk Docker's data lives on,
// which is the disk that fills. Bytes, not -h, so the page can do its own maths.
async function hostDisk() {
  const line = (await sh('df -P -B1 / | tail -1')).split(/\s+/);
  const total = Number(line[1]) || 0;
  const used = Number(line[2]) || 0;
  const available = Number(line[3]) || 0;
  return { total, used, available, usedPercent: parseInt(line[4], 10) || 0 };
}

// Docker reports sizes as "16.42GB" and reclaimable as "11.38GB (69%)".
function parseSize(s) {
  const m = /([\d.]+)\s*([kKMGT]?B)/.exec(String(s || ''));
  if (!m) return 0;
  const mult = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

async function dockerUsage() {
  const out = await docker(['system', 'df', '--format', '{{json .}}']);
  return out.split('\n').filter(Boolean).map((l) => {
    const r = JSON.parse(l);
    return {
      type: r.Type,
      total: Number(r.TotalCount) || 0,
      active: Number(r.Active) || 0,
      size: parseSize(r.Size),
      reclaimable: parseSize(r.Reclaimable)
    };
  });
}

async function platformVersions() {
  const out = await docker(['images', PLATFORM_IMAGE(), '--format', '{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}']);
  return out.split('\n').filter(Boolean).map((l) => {
    const [tag, created, size] = l.split('\t');
    return { tag, created, size: parseSize(size) };
  }).filter((r) => r.tag && r.tag !== '<none>');
}

async function runningVersion() {
  try {
    const image = await docker(['inspect', os.hostname(), '--format', '{{.Config.Image}}']);
    return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
  } catch { return null; }
}

// What each Docker volume takes on disk. `docker system df` counts the bytes
// written to a volume's files, not the blocks they hold, so a store that
// reserves space ahead (SeaweedFS did, 1 GB per volume file) looked tiny there
// while it filled the disk. `du` counts blocks. It runs in a short-lived
// container with every volume mounted read-only and no network.
async function volumeSizes() {
  const names = (await docker(['volume', 'ls', '-q'])).split('\n').map((n) => n.trim())
    .filter((n) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n));
  if (!names.length) return [];
  const image = await docker(['inspect', os.hostname(), '--format', '{{.Config.Image}}']);
  const mounts = names.flatMap((n) => ['--mount', `type=volume,src=${n},dst=/v/${n},readonly`]);
  const out = await docker([
    'run', '--rm', '--network', 'none', '--entrypoint', 'du', ...mounts, image, '-sk', ...names.map((n) => `/v/${n}`)
  ], { timeout: 2 * 60 * 1000 });
  return out.split('\n').map((l) => {
    const m = /^(\d+)\s+\/v\/(.+)$/.exec(l.trim());
    return m ? { name: m[2], size: Number(m[1]) * 1024 } : null;
  }).filter(Boolean).sort((a, b) => b.size - a.size);
}

// du reads every file in every volume, so its answer is kept for a while.
const VOLUME_CACHE_MS = 5 * 60 * 1000;
let volumeCache = null;
async function cachedVolumeSizes({ fresh = false } = {}) {
  if (!fresh && volumeCache && Date.now() - volumeCache.at < VOLUME_CACHE_MS) return volumeCache.value;
  const value = await volumeSizes();
  volumeCache = { at: Date.now(), value };
  return value;
}

// ── free up space ─────────────────────────────────────────────────────────────

// The same rules as the updater and Dockerfile deploys: keep the platform
// version running, the newest other version (the rollback target) and `latest`;
// keep each app's two newest images; skip any image a container still uses,
// which `docker rmi` would refuse. Volumes, containers and backups are never
// touched. Returns the images to remove, with their sizes, so the Server page
// can say what the button will recover before anyone presses it.
async function planRemovals() {
  const plan = [];
  const rows = (await docker(['images', '--format', '{{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}']).catch(() => ''))
    .split('\n').filter(Boolean).map((l) => {
      const [repo, tag, created, size] = l.split('\t');
      return { repo, tag, created, size: parseSize(size) };
    });
  const inUse = new Set((await docker(['ps', '-a', '--format', '{{.Image}}']).catch(() => ''))
    .split('\n').map((r) => r.trim()).filter(Boolean));
  const sizeOf = (repo, tag) => (rows.find((r) => r.repo === repo && r.tag === tag) || {}).size || 0;
  const add = (repo, tag) => {
    const ref = `${repo}:${tag}`;
    if (!inUse.has(ref)) plan.push({ ref, size: sizeOf(repo, tag) });
  };

  const running = await runningVersion();
  const versions = await platformVersions().catch(() => []);
  const newestOther = versions
    .filter((v) => v.tag !== 'latest' && v.tag.replace(/^v/, '') !== String(running || '').replace(/^v/, ''))
    .sort((a, b) => (a.created < b.created ? 1 : -1))[0];
  for (const tag of tagsToRemove(versions.map((v) => v.tag), [running, newestOther && newestOther.tag])) add(PLATFORM_IMAGE(), tag);

  const appRepos = [...new Set(rows.map((r) => r.repo).filter((r) => /^app-[a-z0-9-]+$/.test(r)))];
  for (const repo of appRepos) {
    for (const tag of appTagsToRemove(rows.filter((r) => r.repo === repo), 2)) add(repo, tag);
  }

  // Untagged layers that `docker image prune` clears.
  for (const r of rows) if (r.tag === '<none>' && r.repo === '<none>') plan.push({ ref: '<none>', size: r.size });
  return plan;
}

async function diskUsage({ fresh = false } = {}) {
  const [disk, docker_, versions, running, volumes, plan] = await Promise.all([
    hostDisk(), dockerUsage().catch(() => []), platformVersions().catch(() => []), runningVersion(),
    cachedVolumeSizes({ fresh }).catch(() => null), planRemovals().catch(() => [])
  ]);
  const buildCache = (docker_.find((r) => r.type === 'Build Cache') || {}).reclaimable || 0;
  const images = plan.reduce((n, p) => n + p.size, 0);
  return {
    disk, docker: docker_, platformVersions: versions, runningVersion: running,
    // null when du could not run: the page falls back to Docker's own numbers.
    volumes,
    reclaimable: { total: images + buildCache, images, buildCache, removes: plan.filter((p) => p.ref !== '<none>').map((p) => p.ref) }
  };
}

async function freeSpace() {
  const before = await hostDisk();
  const removed = [];
  for (const { ref } of await planRemovals()) {
    if (ref === '<none>') continue;
    try { await docker(['rmi', ref], { timeout: 2 * 60 * 1000 }); removed.push(ref); }
    catch { /* in use after all */ }
  }
  try { await docker(['image', 'prune', '-f'], { timeout: 5 * 60 * 1000 }); } catch { /* best effort */ }
  try { await docker(['builder', 'prune', '-f'], { timeout: 5 * 60 * 1000 }); } catch { /* best effort */ }
  volumeCache = null;

  const after = await hostDisk();
  return { removed, freedBytes: Math.max(0, after.available - before.available), before, after };
}

// ── the terminal ──────────────────────────────────────────────────────────────

// Values from this process's environment that look like secrets. The runner
// reads the platform .env, so this is the list a `cat .env` would print.
function secretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => /SECRET|TOKEN|PASSWORD|PASS\b|_KEY\b|_PAT\b|PRIVATE/i.test(k) && v && String(v).length >= 8)
    .map(([, v]) => String(v));
}

/**
 * Run `command` as root on the host and stream it as server-sent events:
 * stdout, stderr, then exit (or error). Not a pty: no vim, no top, no prompts.
 */
async function runOnHost(command, res) {
  const image = await docker(['inspect', os.hostname(), '--format', '{{.Config.Image}}']);
  const name = `astrodock-host-${crypto.randomBytes(4).toString('hex')}`;
  const secrets = secretValues();
  const mask = (chunk) => {
    let out = String(chunk);
    for (const v of secrets) if (out.includes(v)) out = out.split(v).join('••••••');
    return out;
  };
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // --pid=host makes the host's PID 1 visible; --privileged lets nsenter join its
  // mount, UTS, IPC, network and PID namespaces. After that the shell is the
  // host's own /bin/sh, seeing the host's filesystem, as root. The container's
  // environment is replaced so nothing from the platform's .env comes along.
  const script = `cd /root 2>/dev/null || cd /\n${command}`;
  const child = spawn('docker', [
    'run', '--rm', '--name', name,
    '--privileged', '--pid=host', '--network=host',
    '--entrypoint', 'nsenter',
    '-e', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e', 'HOME=/root', '-e', 'TERM=dumb', '-e', 'DEBIAN_FRONTEND=noninteractive',
    image,
    '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c', script
  ]);

  let finished = false;
  const kill = () => { if (!finished) execFile('docker', ['rm', '-f', name], () => {}); };
  const timer = setTimeout(() => { send('stderr', '\n(stopped: the 15 minute limit was reached)\n'); kill(); }, EXEC_TIMEOUT_MS);

  child.stdout.on('data', (c) => send('stdout', mask(c)));
  child.stderr.on('data', (c) => send('stderr', mask(c)));
  child.on('close', (code, signal) => {
    finished = true;
    clearTimeout(timer);
    send('exit', { code, signal: signal || null });
    res.end();
  });
  child.on('error', (err) => { finished = true; clearTimeout(timer); send('error', mask(err.message)); res.end(); });

  // Closing the tab, or an agent disconnecting, stops the command.
  res.on('close', () => { clearTimeout(timer); kill(); });
  return child;
}

module.exports = { terminalEnabled, diskUsage, freeSpace, runOnHost, parseSize, secretValues, EXEC_TIMEOUT_MS };
