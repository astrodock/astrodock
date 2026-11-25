'use strict';

// Plan limits on the hosted artifacts service (config.artifacts.plans). A
// person with no artifact_accounts row has no limits: that is every operator of
// a self-hosted install. Checked when something is added, never retroactively:
// a creator who moves to Free keeps what they have and cannot add more.

const { eq, sql } = require('drizzle-orm');
const config = require('../../config');
const { db, schema } = require('../../db');

function fail(message, extra = {}) {
  const e = new Error(message);
  e.status = 403;
  e.code = 'plan_limit';
  Object.assign(e, extra);
  return e;
}

/** { name, label, artifacts, guestsPerArtifact, storageBytes, public } or null for no limits. */
async function planFor(userId) {
  if (!userId) return null;
  const [row] = await db.select().from(schema.artifactAccounts).where(eq(schema.artifactAccounts.userId, userId)).limit(1);
  if (!row) return null;
  const p = config.artifacts.plans[row.plan] || config.artifacts.plans.free;
  return { name: row.plan, ...p, suspended: !!row.suspendedAt };
}

async function checkNewArtifact(userId) {
  const plan = await planFor(userId);
  if (!plan) return;
  if (plan.suspended) throw fail('This account is suspended.');
  if (!plan.artifacts) return;
  const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(schema.artifacts).where(eq(schema.artifacts.ownerId, userId));
  if (n >= plan.artifacts) throw fail(`The ${plan.label} plan includes ${plan.artifacts} artifacts. Upgrade to make more.`, { limit: 'artifacts' });
}

async function checkGuests(artifact, adding) {
  const plan = await planFor(artifact.ownerId);
  if (!plan || !plan.guestsPerArtifact || adding <= 0) return;
  const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, artifact.id));
  if (n + adding > plan.guestsPerArtifact) {
    throw fail(`The ${plan.label} plan shares an artifact with up to ${plan.guestsPerArtifact} people.`, { limit: 'guests' });
  }
}

async function checkPublic(artifact) {
  const plan = await planFor(artifact.ownerId);
  if (plan && !plan.public) throw fail(`Public artifacts are on paid plans. The ${plan.label} plan shares by email only.`, { limit: 'public' });
}

// Storage per owner: files, records and blobs across all their artifacts.
// Totals are cached for a minute; a check adds what the write brings.
const usageCache = new Map();
async function storageUsed(userId) {
  const hit = usageCache.get(userId);
  if (hit && Date.now() - hit.at < 60000) return hit.bytes;
  const rows = await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(f.size), 0) FROM artifact_files f JOIN artifacts a ON a.id = f.artifact_id WHERE a.owner_id = ${userId})
    + (SELECT coalesce(sum(r.size), 0) FROM artifact_records r JOIN artifacts a ON a.id = r.artifact_id WHERE a.owner_id = ${userId})
    + (SELECT coalesce(sum(octet_length(b.data::text)), 0) FROM artifact_blobs b JOIN artifacts a ON a.id = b.artifact_id WHERE a.owner_id = ${userId})
    + (SELECT coalesce(sum(u.size), 0) FROM artifact_uploads u JOIN artifacts a ON a.id = u.artifact_id WHERE a.owner_id = ${userId})
      AS bytes`);
  const bytes = Number(((rows.rows || rows)[0] || {}).bytes || 0);
  usageCache.set(userId, { at: Date.now(), bytes });
  return bytes;
}

async function checkStorage(artifact, addBytes) {
  const plan = await planFor(artifact.ownerId);
  if (!plan || !plan.storageBytes || addBytes <= 0) return;
  const used = await storageUsed(artifact.ownerId);
  if (used + addBytes > plan.storageBytes) {
    throw fail(`The ${plan.label} plan includes ${Math.round(plan.storageBytes / 1024 / 1024)} MB of storage, and this would go over it.`, { limit: 'storage' });
  }
  const hit = usageCache.get(artifact.ownerId);
  if (hit) hit.bytes += addBytes;
}

module.exports = { planFor, checkNewArtifact, checkGuests, checkPublic, checkStorage, storageUsed, _usageCache: usageCache };
