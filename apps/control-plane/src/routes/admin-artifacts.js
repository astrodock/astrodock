'use strict';

// Managing artifacts: the dashboard and agents (a person's session, or a key
// holding artifacts:read / artifacts:write). Mounted before the global JSON
// parser in server.js, because file uploads need multipart and a larger limit.
//
// A caller manages the artifacts they own. Listing also shows the ones shared
// with their email, so a person on the account sees everything they can open.
// artifacts:admin (owner and admin roles) reaches every artifact, for taking
// down abuse.

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { eq, and, desc, inArray, or, sql } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireScope, requirePermission, callerHasScope } = require('../middleware/auth');
const { emitEvent, actorFromAuth } = require('../lib/events');
const pagesLib = require('../lib/pages');
const store = require('../lib/pages-store');
const M = require('../lib/artifacts/manifest');
const A = require('../lib/artifacts/access');
const actions = require('../lib/artifacts/actions');
const feedback = require('../lib/artifacts/feedback');
const logs = require('../lib/artifacts/logs');
const limits = require('../lib/artifacts/limits');

const router = express.Router();
router.use(requireScope('artifacts:read'));
const canWrite = requirePermission('artifacts:write');
router.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.artifacts.maxFileBytes, files: config.artifacts.maxFilesPerUpload } });
const storeId = (publicId) => `artifacts/${publicId}`;
const GUIDE = fs.readFileSync(path.join(__dirname, '..', 'assets', 'artifacts-guide.md'), 'utf8');

function fail(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}
const handle = (fn) => (req, res) => fn(req, res).catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[admin-artifacts]', err.message);
  const body = { error: status >= 500 && config.env === 'production' ? 'Internal error' : err.message };
  if (err.problems) body.problems = err.problems;
  if (err.code) body.code = err.code;
  if (err.limit) body.limit = err.limit;
  res.status(status).json(body);
});

/** The person a caller acts for: the signed-in operator, or the person who made the key. */
function principalId(auth) {
  if (!auth) return null;
  if (auth.type === 'admin') return auth.sub || null;
  return auth.authorizedByUserId || null;
}
const isModerator = (auth) => callerHasScope(auth, 'artifacts:admin');

async function principalEmail(auth) {
  const id = principalId(auth);
  if (!id) return null;
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u ? u.email : null;
}

async function loadOwned(req) {
  const artifact = await A.loadArtifact(req.params.id);
  if (!artifact) throw fail(404, 'No such artifact.');
  const me = principalId(req.auth);
  if (artifact.ownerId && artifact.ownerId === me) return artifact;
  if (isModerator(req.auth)) return artifact;
  // A key from before keys were tied to a person stands for the whole instance.
  if (req.auth.type === 'token' && !req.auth.authorizedByUserId) return artifact;
  throw fail(404, 'No such artifact.');
}

async function listFiles(artifact) {
  return db.select().from(schema.artifactFiles).where(eq(schema.artifactFiles.artifactId, artifact.id)).orderBy(schema.artifactFiles.name);
}
async function listShares(artifact) {
  return db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, artifact.id)).orderBy(schema.artifactShares.email);
}

function serialize(a, { files, shares, access, ownerEmail } = {}) {
  const out = {
    id: a.publicId,
    title: a.title,
    url: `${config.artifactOrigin(a.publicId)}/`,
    entryFile: a.entryFile,
    visibility: a.visibility,
    isActive: a.isActive,
    suspended: !!a.suspendedAt,
    suspendedReason: a.suspendedReason || '',
    folderId: a.folderId,
    manifest: a.manifest || {},
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  };
  if (access) out.access = access;
  if (ownerEmail !== undefined) out.owner = ownerEmail;
  if (files) out.files = files.map((f) => ({ name: f.name, size: f.size, contentType: f.contentType, updatedAt: f.updatedAt }));
  if (shares) out.shares = shares.map((s) => ({ email: s.email, role: s.role, createdAt: s.createdAt }));
  return out;
}

function checkManifest(input) {
  try { return M.normalize(input); } catch (err) {
    if (err instanceof M.ManifestError) throw fail(400, err.message, { problems: err.problems });
    throw err;
  }
}

async function putFile(artifact, name, body, contentType) {
  if (!pagesLib.validFileName(name)) throw fail(400, `Not a valid file name: ${name}`);
  if (name.startsWith('_astrodock')) throw fail(400, 'Names starting with _astrodock are reserved.');
  if (body.length > config.artifacts.maxFileBytes) throw fail(413, `${name} is larger than ${config.artifacts.maxFileBytes} bytes.`);
  await limits.checkStorage(artifact, body.length);
  const ct = contentType && contentType !== 'application/octet-stream' ? contentType : pagesLib.contentTypeFor(name);
  await store.putFile(storeId(artifact.publicId), name, body, ct);
  const key = store.keyFor(storeId(artifact.publicId), name);
  await db.insert(schema.artifactFiles).values({ artifactId: artifact.id, name, size: body.length, contentType: ct, storageKey: key })
    .onConflictDoUpdate({ target: [schema.artifactFiles.artifactId, schema.artifactFiles.name], set: { size: body.length, contentType: ct, storageKey: key, updatedAt: new Date() } });
}

// Files given in JSON: [{ name, content, encoding? }], encoding "base64" for binary.
async function putJsonFiles(artifact, files) {
  if (!Array.isArray(files)) throw fail(400, 'files must be a list of { name, content }.');
  if (files.length > config.artifacts.maxFilesPerUpload) throw fail(400, `At most ${config.artifacts.maxFilesPerUpload} files at once.`);
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') throw fail(400, 'Each file needs a name and content (text).');
    if (!pagesLib.validFileName(f.name)) throw fail(400, `Not a valid file name: ${f.name}`);
  }
  for (const f of files) {
    const body = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
    await putFile(artifact, f.name, body, null);
  }
}

function touch(artifact) {
  return db.update(schema.artifacts).set({ updatedAt: new Date() }).where(eq(schema.artifacts.id, artifact.id));
}

function audit(req, type, artifact, message, meta = {}) {
  emitEvent({
    category: 'pages', type, severity: 'info', ...actorFromAuth(req.auth), ip: req.ip,
    targetType: 'artifact', targetId: artifact.publicId, message, meta: { artifactId: artifact.publicId, ...meta }
  }).catch(() => {});
}

// ── guide and feedback ─────────────────────────────────────────────────────
router.get('/guide', (req, res) => {
  res.type('text/markdown').send(GUIDE.replace(/\{\{ARTIFACTS_DOMAIN\}\}/g, config.artifacts.domain));
});

router.get('/feedback', handle(async (req, res) => {
  const rows = await db.select().from(schema.artifactFeedback).orderBy(desc(schema.artifactFeedback.createdAt)).limit(200);
  res.json({ feedback: rows });
}));

router.post('/feedback', canWrite, handle(async (req, res) => {
  const b = req.body || {};
  let artifact = null;
  if (b.artifactId) artifact = await A.loadArtifact(String(b.artifactId));
  const row = await feedback.submit({
    needed: b.needed, tried: b.tried, workaround: b.workaround,
    artifact, actor: actorFromAuth(req.auth).actor
  });
  res.status(201).json({ feedback: { id: row.id, upstreamStatus: row.upstreamStatus } });
}));

// ── usage across artifacts, and the report queue ───────────────────────────
// Yours by default; every artifact on the instance with ?all=1 and artifacts:admin.
router.get('/usage', handle(async (req, res) => {
  const me = principalId(req.auth);
  const all = req.query.all === '1' && isModerator(req.auth);
  const rows = all
    ? await db.select().from(schema.artifacts).orderBy(desc(schema.artifacts.updatedAt))
    : await db.select().from(schema.artifacts).where(eq(schema.artifacts.ownerId, me)).orderBy(desc(schema.artifacts.updatedAt));
  const stats = new Map((await logs.usage(rows.map((a) => a.id))).map((u) => [u.id, u]));
  const ownerIds = [...new Set(rows.map((a) => a.ownerId).filter(Boolean))];
  const owners = new Map(ownerIds.length
    ? (await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ownerIds))).map((u) => [u.id, u.email])
    : []);
  res.json({
    artifacts: rows.map((a) => {
      const { id: _id, ...u } = stats.get(a.id) || {};
      return { ...serialize(a, { ownerEmail: owners.get(a.ownerId) || null }), usage: u };
    })
  });
}));

router.get('/reports', handle(async (req, res) => {
  if (!isModerator(req.auth)) throw fail(403, 'The report queue needs the artifacts:admin permission.');
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  // The queue is reports of harm by default; ?kind=broken or ?kind=all for the rest.
  const kind = ['broken', 'all'].includes(req.query.kind) ? req.query.kind : 'abuse';
  const conds = [eq(schema.artifactReports.status, status)];
  if (kind !== 'all') conds.push(eq(schema.artifactReports.kind, kind));
  const rows = await db.select({ r: schema.artifactReports, publicId: schema.artifacts.publicId, title: schema.artifacts.title })
    .from(schema.artifactReports).innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.artifactReports.artifactId))
    .where(and(...conds)).orderBy(desc(schema.artifactReports.createdAt)).limit(500);
  res.json({ reports: rows.map(({ r, publicId, title }) => ({ ...reportOut(r), artifact: { id: publicId, title } })) });
}));

router.patch('/reports/:reportId', canWrite, handle(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.reportId)) throw fail(404, 'No such report.');
  const [r] = await db.select().from(schema.artifactReports).where(eq(schema.artifactReports.id, req.params.reportId)).limit(1);
  if (!r) throw fail(404, 'No such report.');
  // The owner closes reports that something is broken; admins close any.
  const [a] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, r.artifactId)).limit(1);
  const owner = a && a.ownerId === principalId(req.auth);
  if (!isModerator(req.auth) && !(owner && r.kind === 'broken')) throw fail(404, 'No such report.');
  const status = (req.body || {}).status === 'open' ? 'open' : 'closed';
  await db.update(schema.artifactReports).set({ status }).where(eq(schema.artifactReports.id, r.id));
  res.json({ report: reportOut({ ...r, status }) });
}));

function reportOut(r) {
  return { id: r.id, kind: r.kind, message: r.message, email: r.email, status: r.status, createdAt: r.createdAt };
}

// ── folders ────────────────────────────────────────────────────────────────
router.get('/folders', handle(async (req, res) => {
  const me = principalId(req.auth);
  const rows = await db.select().from(schema.artifactFolders)
    .where(me ? eq(schema.artifactFolders.ownerId, me) : sql`true`).orderBy(schema.artifactFolders.name);
  res.json({ folders: rows.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })) });
}));

router.post('/folders', canWrite, handle(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!name) throw fail(400, 'A folder needs a name.');
  const [f] = await db.insert(schema.artifactFolders).values({ ownerId: principalId(req.auth), name }).returning();
  res.status(201).json({ folder: { id: f.id, name: f.name, createdAt: f.createdAt } });
}));

async function loadFolder(req, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw fail(404, 'No such folder.');
  const [f] = await db.select().from(schema.artifactFolders).where(eq(schema.artifactFolders.id, id)).limit(1);
  if (!f || (f.ownerId !== principalId(req.auth) && !isModerator(req.auth))) throw fail(404, 'No such folder.');
  return f;
}

router.patch('/folders/:folderId', canWrite, handle(async (req, res) => {
  const f = await loadFolder(req, req.params.folderId);
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!name) throw fail(400, 'A folder needs a name.');
  await db.update(schema.artifactFolders).set({ name, updatedAt: new Date() }).where(eq(schema.artifactFolders.id, f.id));
  res.json({ folder: { id: f.id, name } });
}));

router.delete('/folders/:folderId', canWrite, handle(async (req, res) => {
  const f = await loadFolder(req, req.params.folderId);
  // The artifacts in it stay; they move out of the folder.
  await db.delete(schema.artifactFolders).where(eq(schema.artifactFolders.id, f.id));
  res.status(204).end();
}));

// ── artifacts ──────────────────────────────────────────────────────────────
router.get('/', handle(async (req, res) => {
  const me = principalId(req.auth);
  const all = req.query.all === '1' && isModerator(req.auth);
  let rows;
  const shares = new Map();
  if (all || (req.auth.type === 'token' && !req.auth.authorizedByUserId)) {
    rows = await db.select().from(schema.artifacts).orderBy(desc(schema.artifacts.updatedAt));
  } else {
    const email = await principalEmail(req.auth);
    const shared = email ? await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.email, A.normEmail(email))) : [];
    for (const s of shared) shares.set(s.artifactId, s.role);
    const ids = [...shares.keys()];
    rows = await db.select().from(schema.artifacts)
      .where(ids.length ? or(eq(schema.artifacts.ownerId, me), inArray(schema.artifacts.id, ids)) : eq(schema.artifacts.ownerId, me))
      .orderBy(desc(schema.artifacts.updatedAt));
  }
  res.json({
    artifacts: rows.map((a) => serialize(a, { access: a.ownerId === me ? 'owner' : (shares.get(a.id) || 'admin') }))
  });
}));

router.post('/', canWrite, handle(async (req, res) => {
  const b = req.body || {};
  const owner = principalId(req.auth);
  if (!owner) throw fail(400, 'This key is not tied to a person, so an artifact made with it would have no owner. Use a key made from an account.');
  await limits.checkNewArtifact(owner);
  const manifest = b.manifest === undefined ? {} : b.manifest;
  checkManifest(manifest);
  const entryFile = b.entryFile && pagesLib.validFileName(b.entryFile) ? b.entryFile : 'index.html';
  let folderId = null;
  if (b.folderId) folderId = (await loadFolder(req, b.folderId)).id;
  const title = String(b.title || 'Untitled').trim().slice(0, 200) || 'Untitled';
  let artifact;
  for (let i = 0; i < 5 && !artifact; i++) {
    const rows = await db.insert(schema.artifacts).values({
      publicId: A.generatePublicId(), ownerId: owner, folderId, title, entryFile, manifest
    }).onConflictDoNothing().returning();
    artifact = rows[0];
  }
  if (!artifact) throw fail(500, 'Could not allocate an artifact id.');
  if (typeof b.content === 'string') await putFile(artifact, entryFile, Buffer.from(b.content, 'utf8'), null);
  if (b.files) await putJsonFiles(artifact, b.files);
  audit(req, 'artifact.created', artifact, `Artifact "${title}" created`);
  res.status(201).json({ artifact: serialize(artifact, { files: await listFiles(artifact), shares: [], access: 'owner' }) });
}));

router.get('/:id', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const [o] = artifact.ownerId ? await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId)).limit(1) : [];
  res.json({ artifact: serialize(artifact, { files: await listFiles(artifact), shares: await listShares(artifact), ownerEmail: o ? o.email : null }) });
}));

router.patch('/:id', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const b = req.body || {};
  const set = { updatedAt: new Date() };
  if (b.title !== undefined) set.title = String(b.title).trim().slice(0, 200) || 'Untitled';
  if (b.entryFile !== undefined) {
    if (!pagesLib.validFileName(b.entryFile)) throw fail(400, 'Not a valid file name.');
    set.entryFile = b.entryFile;
  }
  if (b.folderId !== undefined) set.folderId = b.folderId ? (await loadFolder(req, b.folderId)).id : null;
  if (b.manifest !== undefined) { checkManifest(b.manifest); set.manifest = b.manifest; }
  if (b.visibility !== undefined) {
    if (!['shared', 'public'].includes(b.visibility)) throw fail(400, 'visibility is "shared" or "public".');
    if (b.visibility === 'public' && artifact.visibility !== 'public') await limits.checkPublic(artifact);
    set.visibility = b.visibility;
  }
  if (b.isActive !== undefined) set.isActive = !!b.isActive;
  if (b.suspended !== undefined) {
    if (!isModerator(req.auth)) throw fail(403, 'Taking an artifact down needs the artifacts:admin permission.');
    set.suspendedAt = b.suspended ? new Date() : null;
    set.suspendedReason = b.suspended ? String(b.suspendedReason || '').slice(0, 500) : '';
  }
  const [row] = await db.update(schema.artifacts).set(set).where(eq(schema.artifacts.id, artifact.id)).returning();
  if (b.manifest !== undefined) audit(req, 'artifact.manifest_changed', row, `Artifact "${row.title}" manifest changed`);
  if (b.visibility !== undefined && b.visibility !== artifact.visibility) audit(req, 'artifact.visibility_changed', row, `Artifact "${row.title}" is now ${row.visibility}`);
  if (b.suspended !== undefined) audit(req, b.suspended ? 'artifact.suspended' : 'artifact.restored', row, `Artifact "${row.title}" ${b.suspended ? 'taken down' : 'restored'}`);
  // Shares whose role the new manifest no longer has fall to its lowest role.
  const roles = M.normalize(row.manifest).roles;
  const shares = await listShares(row);
  const warnings = shares.filter((s) => !roles.includes(s.role)).map((s) => `${s.email} has role "${s.role}", which the manifest no longer defines; they now have "${roles[roles.length - 1]}".`);
  res.json({ artifact: serialize(row, { files: await listFiles(row), shares }), warnings });
}));

router.delete('/:id', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  await db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifact.id));
  store.deleteAll(storeId(artifact.publicId)).catch(() => {});
  audit(req, 'artifact.deleted', artifact, `Artifact "${artifact.title}" deleted`);
  res.status(204).end();
}));

// ── files ──────────────────────────────────────────────────────────────────
router.post('/:id/files', canWrite, upload.array('files', config.artifacts.maxFilesPerUpload), handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const files = req.files || [];
  if (!files.length) throw fail(400, 'No files uploaded (form field "files").');
  // Optional "paths" (a JSON list in file order) carries nested names, since
  // multipart flattens them to a base name.
  let paths = null;
  if (typeof req.body?.paths === 'string') { try { paths = JSON.parse(req.body.paths); } catch { /* ignore */ } }
  const nameOf = (f, i) => (Array.isArray(paths) && paths[i] ? String(paths[i]) : f.originalname);
  files.forEach((f, i) => { if (!pagesLib.validFileName(nameOf(f, i))) throw fail(400, `Not a valid file name: ${nameOf(f, i)}`); });
  for (let i = 0; i < files.length; i++) await putFile(artifact, nameOf(files[i], i), files[i].buffer, files[i].mimetype);
  await touch(artifact);
  res.json({ files: (await listFiles(artifact)).map((f) => ({ name: f.name, size: f.size, contentType: f.contentType })) });
}));

router.put('/:id/files', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  await putJsonFiles(artifact, (req.body || {}).files);
  await touch(artifact);
  res.json({ files: (await listFiles(artifact)).map((f) => ({ name: f.name, size: f.size, contentType: f.contentType })) });
}));

router.get('/:id/file', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const name = String(req.query.name || '');
  if (!pagesLib.validFileName(name)) throw fail(400, 'Not a valid file name.');
  const obj = await store.getFile(storeId(artifact.publicId), name);
  if (!obj) throw fail(404, 'No such file.');
  if (pagesLib.isTextFile(name)) return res.json({ name, content: obj.body.toString('utf8') });
  res.type(obj.contentType || 'application/octet-stream').send(obj.body);
}));

router.delete('/:id/file', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const name = String(req.query.name || '');
  const rows = await db.delete(schema.artifactFiles)
    .where(and(eq(schema.artifactFiles.artifactId, artifact.id), eq(schema.artifactFiles.name, name))).returning();
  if (!rows[0]) throw fail(404, 'No such file.');
  store.deleteFile(storeId(artifact.publicId), name).catch(() => {});
  await touch(artifact);
  res.status(204).end();
}));

// ── sharing ────────────────────────────────────────────────────────────────
router.get('/:id/shares', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  res.json({ shares: (await listShares(artifact)).map((s) => ({ email: s.email, role: s.role, createdAt: s.createdAt })) });
}));

router.post('/:id/shares', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const b = req.body || {};
  const manifest = M.normalize(artifact.manifest);
  const role = b.role || manifest.roles[manifest.roles.length - 1];
  if (!manifest.roles.includes(role)) throw fail(400, `"${role}" is not one of this artifact's roles (${manifest.roles.join(', ')}).`);
  const emails = [...new Set((Array.isArray(b.emails) ? b.emails : [b.email]).map(A.normEmail).filter(Boolean))];
  if (!emails.length) throw fail(400, 'Give the email addresses to share with (emails: [...]).');
  if (emails.length > 50) throw fail(400, 'At most 50 addresses at once.');
  const invalid = emails.filter((e) => !A.validEmail(e));
  if (invalid.length) throw fail(400, `Not valid email addresses: ${invalid.join(', ')}`);
  const inviter = await principalEmail(req.auth);
  const existingEmails = new Set((await listShares(artifact)).map((s) => s.email));
  await limits.checkGuests(artifact, emails.filter((e) => !existingEmails.has(e)).length);
  const results = [];
  for (const email of emails) {
    const existing = await A.shareFor(artifact.id, email);
    if (existing) {
      if (existing.role !== role) await db.update(schema.artifactShares).set({ role, updatedAt: new Date() }).where(eq(schema.artifactShares.id, existing.id));
      results.push({ email, role, status: existing.role === role ? 'unchanged' : 'role_changed' });
      continue;
    }
    await db.insert(schema.artifactShares).values({ artifactId: artifact.id, email, role, invitedBy: principalId(req.auth) });
    const sent = b.notify === false ? 'not_sent' : await actions.sendInvite(artifact, email, inviter);
    results.push({ email, role, status: 'added', invite: sent });
  }
  audit(req, 'artifact.shared', artifact, `Artifact "${artifact.title}" shared with ${emails.length} address${emails.length === 1 ? '' : 'es'}`, { emails, role });
  res.json({ results, shares: (await listShares(artifact)).map((s) => ({ email: s.email, role: s.role })) });
}));

router.delete('/:id/shares', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const email = A.normEmail(req.query.email || (req.body || {}).email);
  const rows = await db.delete(schema.artifactShares)
    .where(and(eq(schema.artifactShares.artifactId, artifact.id), eq(schema.artifactShares.email, email))).returning();
  if (!rows[0]) throw fail(404, 'That address is not on the share list.');
  audit(req, 'artifact.unshared', artifact, `Artifact "${artifact.title}" no longer shared with ${email}`, { email });
  res.status(204).end();
}));

// End every session on the artifact. People sign in again; shares stay.
router.post('/:id/sessions/revoke', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  await db.update(schema.artifacts).set({ sessionEpoch: artifact.sessionEpoch + 1, updatedAt: new Date() }).where(eq(schema.artifacts.id, artifact.id));
  audit(req, 'artifact.sessions_revoked', artifact, `Every session on "${artifact.title}" ended`);
  res.json({ ok: true });
}));

// ── usage, activity, errors, history, reports for one artifact ─────────────
router.get('/:id/usage', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  await logs.flushReads();
  const [u] = await logs.usage([artifact.id]);
  const { id: _id, ...usage } = u || {};
  res.json({ usage, people: await logs.people(artifact) });
}));

const ACTIVITY = {
  views: () => schema.artifactViews,
  api: () => schema.artifactApiLog,
  signins: () => schema.artifactSignins
};
router.get('/:id/activity', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const kind = ACTIVITY[req.query.kind] ? req.query.kind : 'views';
  const T = ACTIVITY[kind]();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const conds = [eq(T.artifactId, artifact.id)];
  if (req.query.before) {
    const b = new Date(String(req.query.before));
    if (!Number.isNaN(b.getTime())) conds.push(sql`${T.createdAt} < ${b}`);
  }
  if (req.query.email) conds.push(eq(T.email, A.normEmail(req.query.email)));
  const rows = await db.select().from(T).where(and(...conds)).orderBy(desc(T.createdAt)).limit(limit);
  res.json({ kind, entries: rows.map(({ artifactId: _a, ...r }) => r) });
}));

router.get('/:id/errors', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const rows = await db.select().from(schema.artifactErrors).where(eq(schema.artifactErrors.artifactId, artifact.id))
    .orderBy(desc(schema.artifactErrors.lastSeen)).limit(500);
  res.json({
    errors: rows.map((e) => ({
      id: e.id, kind: e.kind, message: e.message, source: e.source, stack: e.stack, path: e.path, userAgent: e.userAgent,
      count: e.count, people: (e.emails || []).length, emails: e.emails || [], firstSeen: e.firstSeen, lastSeen: e.lastSeen
    }))
  });
}));

// Clear the list once the page is fixed, so what comes back is new.
router.delete('/:id/errors', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  await db.delete(schema.artifactErrors).where(eq(schema.artifactErrors.artifactId, artifact.id));
  res.status(204).end();
}));

router.get('/:id/history', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const conds = [eq(schema.artifactRevisions.artifactId, artifact.id)];
  if (req.query.recordId) conds.push(eq(schema.artifactRevisions.recordId, String(req.query.recordId)));
  if (req.query.target) conds.push(eq(schema.artifactRevisions.target, String(req.query.target)));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = await db.select().from(schema.artifactRevisions).where(and(...conds)).orderBy(desc(schema.artifactRevisions.createdAt)).limit(limit);
  res.json({
    history: rows.map((r) => ({
      id: r.id, kind: r.kind, target: r.target, recordId: r.recordId, action: r.action,
      before: r.before, after: r.after, actor: r.actorEmail, createdAt: r.createdAt
    }))
  });
}));

router.get('/:id/reports', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  // Reports that the artifact is harmful go to the platform's admins only.
  const conds = [eq(schema.artifactReports.artifactId, artifact.id)];
  if (!isModerator(req.auth)) conds.push(eq(schema.artifactReports.kind, 'broken'));
  const rows = await db.select().from(schema.artifactReports).where(and(...conds)).orderBy(desc(schema.artifactReports.createdAt)).limit(200);
  res.json({ reports: rows.map(reportOut) });
}));

// ── data, as the owner sees it ─────────────────────────────────────────────
router.get('/:id/data', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const counts = await db.select({ collection: schema.artifactRecords.collection, n: sql`count(*)::int` })
    .from(schema.artifactRecords).where(eq(schema.artifactRecords.artifactId, artifact.id)).groupBy(schema.artifactRecords.collection);
  const blobs = await db.select({ name: schema.artifactBlobs.name, userId: schema.artifactBlobs.userId, version: schema.artifactBlobs.version, updatedAt: schema.artifactBlobs.updatedAt })
    .from(schema.artifactBlobs).where(eq(schema.artifactBlobs.artifactId, artifact.id));
  res.json({ collections: Object.fromEntries(counts.map((c) => [c.collection, c.n])), blobs });
}));

router.get('/:id/data/:collection', handle(async (req, res) => {
  const artifact = await loadOwned(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = await db.select().from(schema.artifactRecords)
    .where(and(eq(schema.artifactRecords.artifactId, artifact.id), eq(schema.artifactRecords.collection, req.params.collection)))
    .orderBy(desc(schema.artifactRecords.createdAt)).limit(limit).offset(offset);
  res.json({ records: rows.map((r) => ({ id: r.id, data: r.data, author: r.authorEmail, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt })) });
}));

router.delete('/:id/data/:collection/:recordId', canWrite, handle(async (req, res) => {
  const artifact = await loadOwned(req);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.recordId)) throw fail(404, 'No such record.');
  const rows = await db.delete(schema.artifactRecords).where(and(eq(schema.artifactRecords.artifactId, artifact.id),
    eq(schema.artifactRecords.collection, req.params.collection), eq(schema.artifactRecords.id, req.params.recordId))).returning();
  if (!rows[0]) throw fail(404, 'No such record.');
  require('../lib/artifacts/live').publish(artifact.id, req.params.collection, { type: 'delete', row: rows[0] });
  await require('../lib/artifacts/uploads').dropForRecord(artifact, rows[0].id);
  logs.revision(artifact, {
    target: req.params.collection, recordId: rows[0].id, action: 'delete', before: rows[0].data,
    viewer: { userId: principalId(req.auth), email: (await principalEmail(req.auth)) || actorFromAuth(req.auth).actor }
  });
  res.status(204).end();
}));

module.exports = router;
