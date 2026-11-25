'use strict';

// Files people attach to records, for collections whose manifest says
// "attachments". Who may attach or remove: anyone the record's update rule
// lets change it, and its author. Who may download: anyone who can read the
// record. Files are served with a sandbox policy and, unless they are plain
// images or PDFs, as downloads, so an uploaded page or script never runs as
// the artifact.

const crypto = require('crypto');
const { and, eq, inArray, sql } = require('drizzle-orm');
const { db, schema } = require('../../db');
const store = require('../pages-store');
const M = require('./manifest');
const limits = require('./limits');
const logs = require('./logs');

const U = schema.artifactUploads;
const R = schema.artifactRecords;
const storeId = (artifact) => `artifacts/${artifact.publicId}/_uploads`;
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf)$/;

function fail(status, message) { const e = new Error(message); e.status = status; return e; }

const fileUrl = (name, recordId, fileId) => `/_astrodock/api/c/${encodeURIComponent(name)}/${recordId}/files/${fileId}`;
const out = (name, u) => ({ id: u.id, name: u.name, size: u.size, type: u.contentType, by: u.uploaderEmail, at: u.createdAt, url: fileUrl(name, u.recordId, u.id) });

/** Add _files to records of a collection that takes attachments. */
async function decorate(artifact, manifest, name, records) {
  const c = manifest.collections[name];
  if (!c || !c.attachments || !records.length) return records;
  const ids = records.map((r) => r.id);
  const rows = await db.select().from(U).where(and(eq(U.artifactId, artifact.id), inArray(U.recordId, ids))).orderBy(U.createdAt);
  const by = new Map();
  for (const u of rows) { if (!by.has(u.recordId)) by.set(u.recordId, []); by.get(u.recordId).push(out(name, u)); }
  return records.map((r) => ({ ...r, _files: by.get(r.id) || [] }));
}

async function recordFor(artifact, manifest, name, id, ctx, op) {
  const c = manifest.collections[name];
  if (!c) throw fail(404, `There is no collection "${name}" in this artifact's manifest.`);
  if (!c.attachments) throw fail(404, `"${name}" does not take attachments. Add "attachments" to it in the manifest.`);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw fail(404, 'No such record.');
  const [row] = await db.select().from(R).where(and(eq(R.artifactId, artifact.id), eq(R.collection, name), eq(R.id, id))).limit(1);
  const readG = M.grant(c.rules.read, manifest, ctx);
  const own = c.scope !== 'per-user' || (ctx.userId && row && row.authorId === ctx.userId);
  if (!row || !own || !M.recordMatches(readG, row, ctx)) throw fail(404, 'No such record.');
  if (op === 'write') {
    if (!ctx.userId) throw fail(401, 'Sign in to attach files.');
    const g = M.grant(c.rules.update, manifest, ctx);
    if (!M.recordMatches(g, row, ctx) && row.authorId !== ctx.userId) throw fail(403, 'You cannot attach files to this record.');
  }
  return { c, row };
}

async function attach(artifact, manifest, name, id, file, ctx) {
  const { c } = await recordFor(artifact, manifest, name, id, ctx, 'write');
  if (!file || !file.buffer) throw fail(400, 'Send the file as multipart form field "file".');
  const type = String(file.mimetype || 'application/octet-stream').toLowerCase();
  if (file.buffer.length > c.attachments.maxBytes) throw fail(413, `A file may be at most ${c.attachments.maxBytes} bytes here.`);
  if (!M.typeAllowed(c.attachments, type)) throw fail(415, `This collection takes ${c.attachments.types.join(', ')}.`);
  const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(U).where(and(eq(U.artifactId, artifact.id), eq(U.recordId, id)));
  if (n >= c.attachments.max) throw fail(409, `A record here takes at most ${c.attachments.max} files.`);
  await limits.checkStorage(artifact, file.buffer.length);
  const fileId = crypto.randomUUID();
  await store.putFile(storeId(artifact), fileId, file.buffer, type);
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = String(file.originalname || 'file').replace(/[\\/\u0000-\u001f"]/g, '_').slice(0, 200) || 'file';
  const [u] = await db.insert(U).values({
    id: fileId, artifactId: artifact.id, collection: name, recordId: id, name: clean, size: file.buffer.length,
    contentType: type, uploaderId: ctx.userId, uploaderEmail: ctx.email || ''
  }).returning();
  logs.revision(artifact, { target: name, recordId: id, action: 'attach', after: { file: clean, size: u.size, type }, viewer: ctx });
  return out(name, u);
}

async function load(artifact, id, fileId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(fileId))) return null;
  const [u] = await db.select().from(U).where(and(eq(U.artifactId, artifact.id), eq(U.recordId, id), eq(U.id, fileId))).limit(1);
  return u || null;
}

async function read(artifact, manifest, name, id, fileId, ctx) {
  await recordFor(artifact, manifest, name, id, ctx, 'read');
  const u = await load(artifact, id, fileId);
  if (!u) throw fail(404, 'No such file.');
  const obj = await store.getFile(storeId(artifact), u.id);
  if (!obj) throw fail(404, 'No such file.');
  return { upload: u, body: obj.body, inline: INLINE.test(u.contentType) };
}

async function detach(artifact, manifest, name, id, fileId, ctx) {
  const { c, row } = await recordFor(artifact, manifest, name, id, ctx, 'read');
  const u = await load(artifact, id, fileId);
  if (!u) throw fail(404, 'No such file.');
  const g = M.grant(c.rules.update, manifest, ctx);
  if (!ctx.userId || (!M.recordMatches(g, row, ctx) && u.uploaderId !== ctx.userId)) throw fail(403, 'You cannot remove this file.');
  await db.delete(U).where(eq(U.id, u.id));
  store.deleteFile(storeId(artifact), u.id).catch(() => {});
  logs.revision(artifact, { target: name, recordId: id, action: 'detach', before: { file: u.name, size: u.size, type: u.contentType }, viewer: ctx });
  return { ok: true };
}

/** A record is gone: its files go with it. */
async function dropForRecord(artifact, id) {
  const rows = await db.delete(U).where(and(eq(U.artifactId, artifact.id), eq(U.recordId, id))).returning();
  for (const u of rows) store.deleteFile(storeId(artifact), u.id).catch(() => {});
}

module.exports = { decorate, attach, read, detach, dropForRecord, storeId, INLINE };
