'use strict';

// Bandwidth for public artifacts: bytes served each calendar month (UTC),
// capped by the owner's plan (publicBytesPerMonth). Counted in memory and
// written once a minute; the total is re-read at most once a minute per
// artifact. Over the cap, the artifact's pages and files stop being served
// until the month turns, and the owner is told once.

const { and, eq, sql } = require('drizzle-orm');
const { db, schema } = require('../../db');
const limits = require('./limits');

const E = schema.artifactEgress;
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const pending = new Map();   // artifactId|month -> bytes not yet written
const totals = new Map();    // artifactId -> { month, bytes, at }

function add(artifact, bytes) {
  if (artifact.visibility !== 'public' || !bytes) return;
  const key = `${artifact.id}|${month()}`;
  pending.set(key, (pending.get(key) || 0) + bytes);
  const t = totals.get(artifact.id);
  if (t && t.month === month()) t.bytes += bytes;
}

async function flush() {
  const batch = [...pending.entries()];
  pending.clear();
  for (const [key, bytes] of batch) {
    const [artifactId, m] = key.split('|');
    await db.insert(E).values({ artifactId, month: m, bytes })
      .onConflictDoUpdate({ target: [E.artifactId, E.month], set: { bytes: sql`${E.bytes} + ${bytes}` } })
      .catch((err) => { if (!/foreign key/i.test(err.message)) console.error('[artifact-egress]', err.message); });
  }
}

async function used(artifact) {
  const m = month();
  const t = totals.get(artifact.id);
  if (t && t.month === m && Date.now() - t.at < 60000) return t.bytes;
  const [row] = await db.select().from(E).where(and(eq(E.artifactId, artifact.id), eq(E.month, m))).limit(1);
  const bytes = (row ? Number(row.bytes) : 0) + (pending.get(`${artifact.id}|${m}`) || 0);
  totals.set(artifact.id, { month: m, bytes, at: Date.now() });
  return bytes;
}

/** Null, or { limit } when a public artifact has used its month. */
async function over(artifact) {
  if (artifact.visibility !== 'public') return null;
  const plan = await limits.planFor(artifact.ownerId);
  const cap = plan && plan.publicBytesPerMonth;
  if (!cap) return null;
  if (await used(artifact) < cap) return null;
  tellOwner(artifact, cap).catch(() => {});
  return { limit: cap };
}

async function tellOwner(artifact, cap) {
  const key = `egress:${month()}`;
  const [sent] = await db.select({ id: schema.artifactSends.id }).from(schema.artifactSends)
    .where(and(eq(schema.artifactSends.artifactId, artifact.id), eq(schema.artifactSends.kind, 'egress-cap'), eq(schema.artifactSends.recipient, key))).limit(1);
  if (sent) return;
  await db.insert(schema.artifactSends).values({ artifactId: artifact.id, ownerId: artifact.ownerId, kind: 'egress-cap', recipient: key });
  const [owner] = artifact.ownerId ? await db.select().from(schema.users).where(eq(schema.users.id, artifact.ownerId)).limit(1) : [];
  if (!owner) return;
  const { sendEmail } = require('../email');
  const { esc } = require('../auth-pages');
  const gb = (cap / 1024 ** 3).toFixed(0);
  await sendEmail({
    to: owner.email,
    subject: `${artifact.title || 'Your artifact'} reached its monthly bandwidth`,
    html: `<p>${esc(artifact.title || 'Your public artifact')} has served ${gb} GB this month, its plan's limit, so it is paused until the month turns (UTC).</p>`
      + `<p>Its data and files are unchanged. Switching it to Shared by Email lifts the pause: the limit is on public artifacts.</p>`
  });
}

let timer = null;
function startFlushing() {
  if (timer) return;
  timer = setInterval(() => { flush().catch(() => {}); }, 60000);
  timer.unref();
}

module.exports = { add, flush, used, over, startFlushing, month, _pending: pending, _totals: totals };
