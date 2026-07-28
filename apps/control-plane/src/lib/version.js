'use strict';

// What version am I running?
//
// Nothing surfaced this before, which meant an operator could not answer the
// question at all without reading `docker images` over SSH — and an install that
// pulled `:latest` genuinely did not know what it had.
//
// The authoritative answer for a released install is baked into the image at
// build time from the git tag. Deliberately NOT called ASTRODOCK_VERSION: that
// name already belongs to the host's .env, where compose reads it to choose an
// image tag, and every service does `env_file: .env` — so a box pinned to
// `latest` would inject ASTRODOCK_VERSION=latest into the container and the
// platform would cheerfully report its version as "latest". Different name,
// no collision.

const path = require('path');

let cached = null;

function readPackageVersion() {
  try {
    return require(path.join(__dirname, '../../package.json')).version || null;
  } catch { return null; }
}

// A source build (docker-compose.build.yml, or `node server.js` in a checkout)
// carries no build args, so fall back to the workspace version and say so —
// "0.0.6 (from source)" is honest in a way that a bare "0.0.6" would not be,
// because a working tree can be anywhere relative to that tag.
function resolve() {
  if (cached) return cached;

  const baked = (process.env.ASTRODOCK_BUILD_VERSION || '').trim();
  const commit = (process.env.ASTRODOCK_BUILD_COMMIT || '').trim();
  const builtAt = (process.env.ASTRODOCK_BUILD_DATE || '').trim();

  cached = baked
    ? { version: baked, commit: commit || null, builtAt: builtAt || null, source: 'image' }
    : { version: readPackageVersion(), commit: commit || null, builtAt: builtAt || null, source: 'source' };

  return cached;
}

// "v0.0.6" and "0.0.6" are the same release; tags carry the v, package.json does not.
function normalize(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

// Compare two semver-ish strings. Returns <0, 0, >0. Pre-release suffixes sort
// before the release they belong to (0.1.0-rc1 < 0.1.0), which is what semver says.
function compare(a, b) {
  const parse = (v) => {
    const [core, pre] = normalize(v).split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre) return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0;
  return 0;
}

function isSemver(v) {
  return /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v || '').trim());
}

module.exports = { resolve, compare, normalize, isSemver };
