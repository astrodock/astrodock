'use strict';

// Which Docker images may go. Pure functions, so the keep rules are tested
// without Docker, and shared by the updater, Dockerfile deploys and the Server
// page's Free Up Space, which must all agree on what is safe to remove.

const norm = (v) => String(v || '').trim().replace(/^v/, '');

/**
 * Platform image tags to remove: everything except `latest` and the versions
 * named in `keepVersions` (the one running, and the rollback target). Versions
 * match with or without a leading "v". Dangling `<none>` tags are left to
 * `docker image prune`.
 */
function tagsToRemove(tags, keepVersions) {
  const keep = new Set((keepVersions || []).map(norm).filter(Boolean));
  return (tags || []).filter((t) => t && t !== '<none>' && t !== 'latest' && !keep.has(norm(t)));
}

/**
 * App image tags to remove: all but the newest `keep`. `rows` are
 * { tag, created } where `created` is Docker's CreatedAt string, which sorts
 * chronologically as text.
 */
function appTagsToRemove(rows, keep) {
  return (rows || [])
    .filter((r) => r && r.tag && r.tag !== '<none>')
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    .slice(Math.max(0, keep))
    .map((r) => r.tag);
}

module.exports = { tagsToRemove, appTagsToRemove };
