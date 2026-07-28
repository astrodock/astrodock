'use strict';

// "Is there a newer Astrodock?"
//
// Asks GitHub for the repository's tags and compares the highest semver one
// against what this box is running. Tags rather than Releases: the release
// workflow publishes images from `v*` tags and does not create GitHub Release
// objects, so /releases/latest would 404 on a repo that is releasing perfectly
// well.
//
// Deliberately does NOT update anything. It reports, and hands over the command.
//
// Three rules, because this is the platform's only outbound call:
//   • cached hard, so opening Settings does not hit GitHub every time
//   • never throws into a request — an unreachable GitHub means "unknown", which
//     is different from "up to date" and is reported differently
//   • switchable off, for boxes that should not talk to the internet at all

const version = require('./version');
const { getSetting } = require('./settings');

const REPO = process.env.ASTRODOCK_UPDATE_REPO || 'astrodock/astrodock';
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=50`;
const TTL_MS = 6 * 3600 * 1000;   // six hours; releases are not that frequent
const ERROR_TTL_MS = 15 * 60 * 1000;

let cache = null;   // { at, result }

function releaseUrl(tag) {
  return `https://github.com/${REPO}/releases/tag/${tag}`;
}

async function fetchLatestTag() {
  const res = await fetch(TAGS_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'astrodock' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const tags = await res.json();
  if (!Array.isArray(tags)) throw new Error('unexpected response from GitHub');

  // The tags endpoint is not ordered by version, so sort them properly rather
  // than trusting whatever came back first.
  const semver = tags.map((t) => t.name).filter(version.isSemver)
    .sort((a, b) => version.compare(b, a));
  if (!semver.length) throw new Error('no version tags published yet');
  return semver[0];
}

// Settings live in Postgres, and this runs on a request the Settings page makes
// at mount. `.catch()` covers a failed read but not a hung one — a wedged pool
// would leave the page waiting forever on a check that is, at worst, optional.
function settingOr(key, fallback, ms = 2000) {
  return Promise.race([
    getSetting(key, fallback).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())
  ]);
}

async function check({ force = false } = {}) {
  const current = version.resolve();

  const enabled = (await settingOr('updates.check', 'on')) === 'on';
  if (!enabled) {
    return { status: 'disabled', current, message: 'Update checking is switched off.' };
  }

  const ttl = cache?.result?.status === 'error' ? ERROR_TTL_MS : TTL_MS;
  if (!force && cache && Date.now() - cache.at < ttl) {
    return { ...cache.result, cachedAt: new Date(cache.at).toISOString() };
  }

  let result;
  try {
    const latest = await fetchLatestTag();
    // A source build's package.json version says which release the tree is
    // descended from, not what it contains, so comparing it to a tag would
    // announce an update for a checkout that may well be ahead of one.
    if (!current.version || !version.isSemver(current.version)) {
      result = { status: 'unknown', current, latest, url: releaseUrl(latest),
        message: 'This build does not report a version, so it cannot be compared.' };
    } else {
      const behind = version.compare(current.version, latest) < 0;
      result = {
        status: behind ? 'behind' : 'current',
        current, latest, url: releaseUrl(latest),
        message: behind
          ? `${latest} is available. You are on ${version.normalize(current.version)}.`
          : 'You are on the latest release.'
      };
    }
  } catch (err) {
    result = { status: 'error', current, error: err.message,
      message: `Could not reach GitHub to check: ${err.message}` };
  }

  cache = { at: Date.now(), result };
  return { ...result, cachedAt: new Date(cache.at).toISOString() };
}

module.exports = { check, releaseUrl, _reset: () => { cache = null; } };
