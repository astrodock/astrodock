'use strict';

// Live updates for artifact collections. A change is emitted in this process
// at once, and sent through Postgres (NOTIFY artifact_changes) so that any
// other control-plane process serving the same artifact emits it to its own
// streams too. Each subscriber filters changes through its own read grant
// before anything is sent (routes/artifacts-public).
//
// A NOTIFY payload is capped at 8000 bytes, so a large record travels as its
// id and the receiving process reads it back; a large deleted record travels
// without its data, which is enough for author rules but not field rules.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);
const PROCESS = crypto.randomUUID();
const CHANNEL = 'artifact_changes';
const MAX_PAYLOAD = 7000;

const channel = (artifactId, collection) => `${artifactId}:${collection}`;

function payload(artifactId, collection, change) {
  const full = JSON.stringify({ p: PROCESS, a: artifactId, c: collection, t: change.type, row: change.row });
  if (full.length <= MAX_PAYLOAD) return full;
  const r = change.row;
  const slim = { id: r.id, artifactId: r.artifactId, collection: r.collection, authorId: r.authorId, authorEmail: r.authorEmail };
  return JSON.stringify({ p: PROCESS, a: artifactId, c: collection, t: change.type, row: slim, fetch: change.type !== 'delete' });
}

/** change: { type: 'create'|'update'|'delete', row } — row in stored form. */
function publish(artifactId, collection, change) {
  bus.emit(channel(artifactId, collection), change);
  if (!listening) return;
  try {
    const { client } = require('../../db');
    client.notify(CHANNEL, payload(artifactId, collection, change)).catch((err) => console.error('[artifact-live] notify:', err.message));
  } catch (err) { console.error('[artifact-live] notify:', err.message); }
}

async function receive(text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || m.p === PROCESS) return;
  let row = m.row;
  if (m.fetch) {
    const { db, schema } = require('../../db');
    const { eq } = require('drizzle-orm');
    [row] = await db.select().from(schema.artifactRecords).where(eq(schema.artifactRecords.id, row.id)).limit(1);
    if (!row) return;
  } else if (row) {
    for (const k of ['createdAt', 'updatedAt']) if (row[k]) row[k] = new Date(row[k]);
  }
  bus.emit(channel(m.a, m.c), { type: m.t, row });
}

let listening = false;
async function start() {
  if (listening) return;
  const { client } = require('../../db');
  await client.listen(CHANNEL, (text) => { receive(text).catch((err) => console.error('[artifact-live] receive:', err.message)); });
  listening = true;
}

function subscribe(artifactId, collection, fn) {
  const ch = channel(artifactId, collection);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}

function listenerCount(artifactId, collection) {
  return bus.listenerCount(channel(artifactId, collection));
}

module.exports = { publish, subscribe, listenerCount, start, receive, payload, PROCESS };
