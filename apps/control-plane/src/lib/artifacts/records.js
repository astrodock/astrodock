'use strict';

// Collections and blobs: every read and write an artifact's page makes, with the
// manifest's rules applied. The caller passes ctx = { role, userId, email }, as
// resolved from the artifact session (role null for an anonymous visitor of a
// public artifact).
//
// Errors carry .status so routes can return them as they are.

const { and, eq, or, sql, isNull } = require('drizzle-orm');
const config = require('../../config');
const { db, schema } = require('../../db');
const M = require('./manifest');
const live = require('./live');
const logs = require('./logs');
const limits = require('./limits');

const R = schema.artifactRecords;
const B = schema.artifactBlobs;

function fail(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function collectionOf(manifest, name) {
  const c = manifest.collections[name];
  if (!c) throw fail(404, `There is no collection "${name}" in this artifact's manifest.`);
  return c;
}

/** A stored record as the page sees it: its fields, plus id and _-prefixed metadata. */
function toClient(row) {
  return {
    ...(row.data || {}),
    id: row.id,
    _author: row.authorEmail || null,
    _createdAt: row.createdAt,
    _updatedAt: row.updatedAt,
    _version: row.version
  };
}

// Conditions limiting a query to what one grant lets the viewer see.
function visibility(c, g, ctx) {
  const conds = [];
  if (c.scope === 'per-user') {
    if (!ctx.userId) return [sql`false`];
    conds.push(eq(R.authorId, ctx.userId));
  }
  if (!g.all) {
    const any = [];
    if (g.author && ctx.userId) any.push(eq(R.authorId, ctx.userId));
    const me = String(ctx.email || '').toLowerCase();
    if (me) for (const f of g.fields) any.push(sql`lower(${R.data} ->> ${f}) = ${me}`);
    conds.push(any.length ? or(...any) : sql`false`);
  }
  return conds;
}

function ownRecordOk(c, row, ctx) {
  return c.scope !== 'per-user' || (ctx.userId && row.authorId === ctx.userId);
}

const ORDER_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * List records. opts: { where: {field: value}, order: "field" | "-field" |
 * "_createdAt" | "-_updatedAt", limit, offset }.
 */
async function list(artifact, manifest, name, ctx, opts = {}) {
  const c = collectionOf(manifest, name);
  const g = M.grant(c.rules.read, manifest, ctx);
  if (!g) throw fail(403, `Your role cannot read "${name}".`);
  const conds = [eq(R.artifactId, artifact.id), eq(R.collection, name), ...visibility(c, g, ctx)];
  if (opts.where && Object.keys(opts.where).length) {
    for (const k of Object.keys(opts.where)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) throw fail(400, `"${k}" is not a field name.`);
    }
    conds.push(sql`${R.data} @> ${JSON.stringify(opts.where)}::jsonb`);
  }
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  let orderBy = sql`${R.createdAt} asc`;
  if (opts.order) {
    const raw = String(opts.order);
    const desc = raw.startsWith('-');
    const key = desc ? raw.slice(1) : raw;
    const dir = desc ? sql`desc` : sql`asc`;
    if (key === '_createdAt') orderBy = sql`${R.createdAt} ${dir}`;
    else if (key === '_updatedAt') orderBy = sql`${R.updatedAt} ${dir}`;
    else if (ORDER_FIELD.test(key)) orderBy = sql`(${R.data} -> ${key}) ${dir} nulls last, ${R.createdAt} asc`;
    else throw fail(400, `Cannot order by "${raw}".`);
  }
  const rows = await db.select().from(R).where(and(...conds)).orderBy(orderBy).limit(limit).offset(offset);
  return rows.map(toClient);
}

async function loadRow(artifact, name, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const [row] = await db.select().from(R).where(and(eq(R.artifactId, artifact.id), eq(R.collection, name), eq(R.id, id))).limit(1);
  return row || null;
}

async function get(artifact, manifest, name, id, ctx) {
  const c = collectionOf(manifest, name);
  const g = M.grant(c.rules.read, manifest, ctx);
  if (!g) throw fail(403, `Your role cannot read "${name}".`);
  const row = await loadRow(artifact, name, id);
  if (!row || !ownRecordOk(c, row, ctx) || !M.recordMatches(g, row, ctx)) throw fail(404, 'No such record.');
  return toClient(row);
}

// ── stamps (built-in action) ───────────────────────────────────────────────
function applyStamps(manifest, name, event, data, ctx) {
  for (const a of manifest.actions) {
    if (a.do !== 'stamp' || !a.on.some((o) => o.collection === name && o.event === event)) continue;
    const value = a.value === 'me.email' ? (ctx.email || null) : new Date().toISOString();
    if (!a.when) { data[a.field] = value; continue; }
    const holds = data[a.when.field] === a.when.is;
    if (holds && (data[a.field] == null || data[a.field] === '')) data[a.field] = value;
    if (!holds) data[a.field] = null;
  }
  return data;
}

function sizeOf(data) { return Buffer.byteLength(JSON.stringify(data)); }

async function create(artifact, manifest, name, input, ctx) {
  const c = collectionOf(manifest, name);
  // Anonymous visitors of a public artifact can only read: 401, so the page can offer sign-in.
  if (!ctx.userId) throw fail(401, 'Sign in to add records.');
  const g = M.grant(c.rules.create, manifest, ctx);
  if (!g || !g.all) throw fail(403, `Your role cannot add to "${name}".`);
  const problems = M.validateData(c, input || {});
  if (problems.length) throw fail(400, problems.join('; '), { problems });
  const data = applyStamps(manifest, name, 'create', { ...input }, ctx);
  const size = sizeOf(data);
  if (size > config.artifacts.maxRecordBytes) throw fail(413, `A record may be at most ${config.artifacts.maxRecordBytes} bytes.`);
  await limits.checkStorage(artifact, size);
  const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(R).where(eq(R.artifactId, artifact.id));
  if (n >= config.artifacts.maxRecordsPerArtifact) throw fail(409, `This artifact has reached its limit of ${config.artifacts.maxRecordsPerArtifact} records.`);
  const [row] = await db.insert(R).values({
    artifactId: artifact.id, collection: name, authorId: ctx.userId, authorEmail: ctx.email || '', data, size
  }).returning();
  live.publish(artifact.id, name, { type: 'create', row });
  logs.revision(artifact, { target: name, recordId: row.id, action: 'create', after: row.data, viewer: ctx });
  afterChange(artifact, manifest, name, 'create', row, null, ctx);
  return toClient(row);
}

async function update(artifact, manifest, name, id, patch, ctx) {
  const c = collectionOf(manifest, name);
  if (!ctx.userId) throw fail(401, 'Sign in to change records.');
  const g = M.grant(c.rules.update, manifest, ctx);
  if (!g) throw fail(403, `Your role cannot change records in "${name}".`);
  const row = await loadRow(artifact, name, id);
  // A record you cannot read is answered as missing, not forbidden.
  const readG = M.grant(c.rules.read, manifest, ctx);
  if (!row || !ownRecordOk(c, row, ctx) || !M.recordMatches(readG, row, ctx)) throw fail(404, 'No such record.');
  if (!M.recordMatches(g, row, ctx)) throw fail(403, 'You cannot change this record.');
  const p = { ...(patch || {}) };
  const expected = p._version;
  delete p._version;
  const problems = M.validateData(c, p, { partial: true });
  if (problems.length) throw fail(400, problems.join('; '), { problems });
  if (expected !== undefined && Number(expected) !== row.version) {
    throw fail(409, 'This record changed since you loaded it.', { current: toClient(row) });
  }
  const data = applyStamps(manifest, name, 'update', { ...row.data, ...p }, ctx);
  const size = sizeOf(data);
  if (size > config.artifacts.maxRecordBytes) throw fail(413, `A record may be at most ${config.artifacts.maxRecordBytes} bytes.`);
  await limits.checkStorage(artifact, size - (row.size || 0));
  const rows = await db.update(R).set({ data, size, version: row.version + 1, updatedAt: new Date() })
    .where(and(eq(R.id, row.id), eq(R.version, row.version))).returning();
  if (!rows[0]) {
    const now = await loadRow(artifact, name, id);
    throw fail(409, 'This record changed since you loaded it.', { current: now ? toClient(now) : null });
  }
  live.publish(artifact.id, name, { type: 'update', row: rows[0] });
  logs.revision(artifact, { target: name, recordId: row.id, action: 'update', before: row.data, after: rows[0].data, viewer: ctx });
  afterChange(artifact, manifest, name, 'update', rows[0], row, ctx);
  return toClient(rows[0]);
}

async function remove(artifact, manifest, name, id, ctx) {
  const c = collectionOf(manifest, name);
  if (!ctx.userId) throw fail(401, 'Sign in to delete records.');
  const g = M.grant(c.rules.delete, manifest, ctx);
  if (!g) throw fail(403, `Your role cannot delete records in "${name}".`);
  const row = await loadRow(artifact, name, id);
  const readG = M.grant(c.rules.read, manifest, ctx);
  if (!row || !ownRecordOk(c, row, ctx) || !M.recordMatches(readG, row, ctx)) throw fail(404, 'No such record.');
  if (!M.recordMatches(g, row, ctx)) throw fail(403, 'You cannot delete this record.');
  await db.delete(R).where(eq(R.id, row.id));
  live.publish(artifact.id, name, { type: 'delete', row });
  logs.revision(artifact, { target: name, recordId: row.id, action: 'delete', before: row.data, viewer: ctx });
  afterChange(artifact, manifest, name, 'delete', row, row, ctx);
  return { ok: true, id: row.id };
}

/** Counts grouped by one field, over the records the viewer can read. */
async function count(artifact, manifest, name, ctx, { by, where } = {}) {
  const c = collectionOf(manifest, name);
  const g = M.grant(c.rules.read, manifest, ctx);
  if (!g) throw fail(403, `Your role cannot read "${name}".`);
  const conds = [eq(R.artifactId, artifact.id), eq(R.collection, name), ...visibility(c, g, ctx)];
  if (where && Object.keys(where).length) conds.push(sql`${R.data} @> ${JSON.stringify(where)}::jsonb`);
  if (!by) {
    const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(R).where(and(...conds));
    return { total: n };
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(by))) throw fail(400, `"${by}" is not a field name.`);
  const rows = await db.select({ k: sql`${R.data} ->> ${String(by)}`, n: sql`count(*)::int` })
    .from(R).where(and(...conds)).groupBy(sql`1`);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[r.k == null ? '' : r.k] = r.n; total += r.n; }
  return { total, by: String(by), counts };
}

// ── blobs ──────────────────────────────────────────────────────────────────
function blobOf(manifest, name) {
  const b = manifest.blobs[name];
  if (!b) throw fail(404, `There is no blob "${name}" in this artifact's manifest.`);
  return b;
}

function blobCond(artifact, b, name, ctx) {
  const base = [eq(B.artifactId, artifact.id), eq(B.name, name)];
  if (b.scope === 'per-user') return [...base, eq(B.userId, ctx.userId)];
  return [...base, isNull(B.userId)];
}

async function getBlob(artifact, manifest, name, ctx) {
  const b = blobOf(manifest, name);
  const g = M.grant(b.rules.read, manifest, ctx);
  if (!g || !g.all) throw fail(403, `Your role cannot read "${name}".`);
  if (b.scope === 'per-user' && !ctx.userId) return { data: {}, version: 0 };
  const [row] = await db.select().from(B).where(and(...blobCond(artifact, b, name, ctx))).limit(1);
  return { data: row ? row.data : {}, version: row ? row.version : 0, updatedAt: row ? row.updatedAt : null };
}

async function setBlob(artifact, manifest, name, data, version, ctx) {
  const b = blobOf(manifest, name);
  if (!ctx.userId) throw fail(401, `Sign in to change "${name}".`);
  const g = M.grant(b.rules.write, manifest, ctx);
  if (!g || !g.all) throw fail(403, `Your role cannot change "${name}".`);
  if (data === undefined) throw fail(400, 'Send { data, version }.');
  if (Buffer.byteLength(JSON.stringify(data)) > config.artifacts.maxBlobBytes) {
    throw fail(413, `A blob may be at most ${config.artifacts.maxBlobBytes} bytes.`);
  }
  const [row] = await db.select().from(B).where(and(...blobCond(artifact, b, name, ctx))).limit(1);
  await limits.checkStorage(artifact, Buffer.byteLength(JSON.stringify(data)) - (row ? Buffer.byteLength(JSON.stringify(row.data)) : 0));
  if (row) {
    if (version !== undefined && Number(version) !== row.version) throw fail(409, 'This changed since you loaded it.', { current: { data: row.data, version: row.version } });
    const rows = await db.update(B).set({ data, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(B.id, row.id), eq(B.version, row.version))).returning();
    if (!rows[0]) throw fail(409, 'This changed since you loaded it.');
    logs.revision(artifact, { kind: 'blob', target: name, action: 'update', before: row.data, after: data, viewer: ctx });
    return { ok: true, version: rows[0].version };
  }
  if (version !== undefined && Number(version) !== 0) throw fail(409, 'This changed since you loaded it.', { current: { data: {}, version: 0 } });
  const rows = await db.insert(B).values({
    artifactId: artifact.id, name, userId: b.scope === 'per-user' ? ctx.userId : null, data, version: 1
  }).onConflictDoNothing().returning();
  if (!rows[0]) throw fail(409, 'This changed since you loaded it.');
  logs.revision(artifact, { kind: 'blob', target: name, action: 'create', after: data, viewer: ctx });
  return { ok: true, version: 1 };
}

// Built-in actions that send mail run after the response, so a slow provider
// never holds up a write. Required lazily: actions needs this module's toClient.
function afterChange(artifact, manifest, name, event, row, before, ctx) {
  if (!manifest.actions.some((a) => a.do === 'email')) return;
  setImmediate(() => {
    require('./actions').onChange(artifact, manifest, name, event, row, before, ctx)
      .catch((err) => console.error('[artifacts] action failed:', err.message));
  });
}

module.exports = { list, get, create, update, remove, count, getBlob, setBlob, toClient, applyStamps, fail };
