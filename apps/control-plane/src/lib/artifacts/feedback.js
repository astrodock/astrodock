'use strict';

// Capability feedback: what an agent building an artifact needed that the
// framework could not do. The agent guide tells agents to send it whenever they
// hit such a limit (src/assets/artifacts-guide.md).
//
// Every item is kept on this instance and sent upstream to the Astrodock
// project (config.artifacts.upstreamFeedbackUrl), which is where it is useful.
// What goes upstream is the agent's own text and the artifact's manifest: no
// records, no email addresses, no file contents, no artifact id.

const { eq } = require('drizzle-orm');
const config = require('../../config');
const { db, schema } = require('../../db');

const MAX = { needed: 2000, tried: 2000, workaround: 2000 };

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function platformVersion() {
  try { return require('../version').resolve().version || ''; } catch { return ''; }
}

async function sendUpstream(row) {
  const url = config.artifacts.upstreamFeedbackUrl;
  if (!url) return { status: 'none', error: '' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'astrodock-capability-feedback' },
      body: JSON.stringify({
        needed: row.needed, tried: row.tried, workaround: row.workaround,
        manifest: row.manifest, platformVersion: row.platformVersion
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { status: 'failed', error: `HTTP ${res.status}` };
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: String(err.message || err).slice(0, 300) };
  }
}

/** Keep an item and send it upstream. Returns the stored row. */
async function submit({ needed, tried, workaround, artifact, actor }) {
  const n = clean(needed, MAX.needed);
  if (!n) { const e = new Error('Say what you needed (needed).'); e.status = 400; throw e; }
  const [row] = await db.insert(schema.artifactFeedback).values({
    source: 'local',
    artifactId: artifact ? artifact.id : null,
    needed: n, tried: clean(tried, MAX.tried), workaround: clean(workaround, MAX.workaround),
    manifest: artifact ? artifact.manifest : null,
    platformVersion: platformVersion(),
    actor: clean(actor, 200),
    upstreamStatus: 'pending'
  }).returning();
  const sent = await sendUpstream(row);
  const [updated] = await db.update(schema.artifactFeedback)
    .set({ upstreamStatus: sent.status, upstreamError: sent.error })
    .where(eq(schema.artifactFeedback.id, row.id)).returning();
  return updated || row;
}

/** An item arriving from another instance (routes/upstream.js). */
async function receive(body) {
  const b = body || {};
  const n = clean(b.needed, MAX.needed);
  if (!n) { const e = new Error('needed is required'); e.status = 400; throw e; }
  let manifest = null;
  if (b.manifest && typeof b.manifest === 'object' && JSON.stringify(b.manifest).length <= 64 * 1024) manifest = b.manifest;
  const [row] = await db.insert(schema.artifactFeedback).values({
    source: 'upstream', needed: n, tried: clean(b.tried, MAX.tried), workaround: clean(b.workaround, MAX.workaround),
    manifest, platformVersion: clean(b.platformVersion, 40), actor: '', upstreamStatus: 'none'
  }).returning();
  return row;
}

module.exports = { submit, receive, sendUpstream };
