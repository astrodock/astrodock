'use strict';

// Manage Pages (admin JWT or a token with the `pages` scope). Mounted BEFORE the
// global express.json in server.js because it needs multipart (multer) + a larger
// JSON limit for the in-browser text editor.

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { eq, and, desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireScope } = require('../middleware/auth');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const { emitEvent, actorFromAuth } = require('../lib/events');
const pages = require('../lib/pages');
const store = require('../lib/pages-store');

const router = express.Router();
router.use(requireScope('pages'));
router.use(express.json({ limit: config.pages.editTextMaxBytes }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.pages.maxFileBytes, files: config.pages.maxFilesPerUpload } });
const scheme = () => (config.tlsMode === 'off' ? 'http' : 'https');

const ACCESS = ['public', 'passkey', 'platform'];
const DATA = ['none', 'shared', 'per-user'];
function genPasskey() { return crypto.randomBytes(9).toString('base64url'); }

async function loadPage(pageId) {
  const rows = await db.select().from(schema.pages).where(eq(schema.pages.pageId, pageId)).limit(1);
  return rows[0] || null;
}
async function listFiles(pageUuid) {
  return db.select().from(schema.pageFiles).where(eq(schema.pageFiles.pageId, pageUuid)).orderBy(schema.pageFiles.name);
}
function serialize(page, files, { includePasskey = false } = {}) {
  const out = {
    pageId: page.pageId, title: page.title, entryFile: page.entryFile,
    accessMode: page.accessMode, dataMode: page.dataMode, allowlist: page.allowlist || [],
    isActive: page.isActive, views: page.views, lastViewedAt: page.lastViewedAt,
    url: `${scheme()}://${config.pages.host}/${page.pageId}/`,
    createdAt: page.createdAt, updatedAt: page.updatedAt
  };
  if (files) out.files = files.map((f) => ({ name: f.name, size: f.size, contentType: f.contentType }));
  if (includePasskey && page.accessMode === 'passkey') out.passkey = decryptSecret(page.passkey);
  return out;
}

// Validate + normalize the access/data/passkey fields for create or patch.
// Returns the columns to set, or throws {status,message}.
function accessFields(body, current) {
  const set = {};
  let accessMode = body.accessMode !== undefined ? body.accessMode : current?.accessMode || 'public';
  let dataMode = body.dataMode !== undefined ? body.dataMode : current?.dataMode || 'none';
  if (!ACCESS.includes(accessMode)) { const e = new Error('invalid accessMode'); e.status = 400; throw e; }
  if (!DATA.includes(dataMode)) { const e = new Error('invalid dataMode'); e.status = 400; throw e; }
  if (dataMode !== 'none' && accessMode === 'public') { const e = new Error('a page with saved data must use access "passkey" or "platform" (writes can\'t be anonymous)'); e.status = 400; throw e; }
  if (dataMode === 'per-user' && accessMode !== 'platform') { const e = new Error('per-user data requires access "platform" (needs a logged-in user)'); e.status = 400; throw e; }
  set.accessMode = accessMode;
  set.dataMode = dataMode;

  if (body.allowlist !== undefined) {
    if (!Array.isArray(body.allowlist)) { const e = new Error('allowlist must be an array of emails'); e.status = 400; throw e; }
    set.allowlist = body.allowlist.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  }

  // passkey handling
  if (accessMode === 'passkey') {
    if (body.generatePasskey) set.passkey = encryptSecret(genPasskey());
    else if (typeof body.passkey === 'string' && body.passkey.length >= 4) set.passkey = encryptSecret(body.passkey);
    else if (body.passkey === null || body.passkey === '') { const e = new Error('passkey must be at least 4 chars'); e.status = 400; throw e; }
    else if (!current || current.accessMode !== 'passkey' || !current.passkey) set.passkey = encryptSecret(genPasskey());
  } else {
    set.passkey = null; // leaving passkey mode clears it
  }
  return set;
}

// ── CRUD ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const access = accessFields(b, null);
    const entryFile = b.entryFile && pages.validFileName(b.entryFile) ? b.entryFile : 'index.html';
    const rows = await db.insert(schema.pages).values({
      pageId: pages.generatePageId(), title: b.title || 'Untitled', entryFile, ...access
    }).returning();
    const page = rows[0];
    // convenience: inline `content` becomes the entry file (text)
    if (typeof b.content === 'string' && b.content.length) {
      const ct = pages.contentTypeFor(entryFile);
      await store.putFile(page.pageId, entryFile, Buffer.from(b.content, 'utf8'), ct);
      await db.insert(schema.pageFiles).values({ pageId: page.id, name: entryFile, size: Buffer.byteLength(b.content), contentType: ct, storageKey: store.keyFor(page.pageId, entryFile) });
    }
    const files = await listFiles(page.id);
    emitEvent({
      category: 'pages', type: 'page.published', severity: 'info',
      ...actorFromAuth(req.auth), ip: req.ip,
      targetType: 'page', targetId: page.pageId,
      message: `Page "${page.title}" published`,
      meta: { pageId: page.pageId, accessMode: page.accessMode, url: serialize(page).url }
    }).catch(() => {});
    res.status(201).json({ page: serialize(page, files, { includePasskey: true }) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/', async (req, res) => {
  const rows = await db.select().from(schema.pages).orderBy(desc(schema.pages.createdAt));
  res.json({ pages: rows.map((p) => serialize(p)) });
});

router.get('/:pageId', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json({ page: serialize(page, await listFiles(page.id), { includePasskey: true }) });
});

// Access analytics for a page (from the page_views log + the lifetime counter).
router.get('/:pageId/views', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const rows = await db.select().from(schema.pageViews)
    .where(eq(schema.pageViews.pageId, page.id))
    .orderBy(desc(schema.pageViews.createdAt)).limit(500);
  const referrers = {}, paths = {}, ips = new Set();
  const weekAgo = Date.now() - 7 * 864e5;
  let last7 = 0;
  for (const v of rows) {
    if (v.referrer) referrers[v.referrer] = (referrers[v.referrer] || 0) + 1;
    paths[v.path] = (paths[v.path] || 0) + 1;
    if (v.ip) ips.add(v.ip);
    if (new Date(v.createdAt).getTime() >= weekAgo) last7++;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ key, count }));
  res.json({
    views: page.views, lastViewedAt: page.lastViewedAt,
    sampleSize: rows.length, last7d: last7, uniqueIps: ips.size,
    topReferrers: top(referrers), topPaths: top(paths),
    recent: rows.slice(0, 30).map((v) => ({ path: v.path, ip: v.ip, referrer: v.referrer, status: v.status, createdAt: v.createdAt }))
  });
});

router.patch('/:pageId', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const b = req.body || {};
  try {
    const set = { updatedAt: new Date() };
    if (b.title !== undefined) set.title = String(b.title);
    if (b.isActive !== undefined) set.isActive = !!b.isActive;
    if (b.entryFile !== undefined) {
      if (!pages.validFileName(b.entryFile)) return res.status(400).json({ error: 'invalid entryFile' });
      const exists = await db.select().from(schema.pageFiles).where(and(eq(schema.pageFiles.pageId, page.id), eq(schema.pageFiles.name, b.entryFile))).limit(1);
      if (!exists[0]) return res.status(400).json({ error: 'entryFile must be an uploaded file' });
      set.entryFile = b.entryFile;
    }
    if (b.accessMode !== undefined || b.dataMode !== undefined || b.passkey !== undefined || b.generatePasskey !== undefined || b.allowlist !== undefined) {
      Object.assign(set, accessFields(b, page));
    }
    const rows = await db.update(schema.pages).set(set).where(eq(schema.pages.id, page.id)).returning();
    res.json({ page: serialize(rows[0], await listFiles(page.id), { includePasskey: true }) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/:pageId/generate-passkey', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const pk = genPasskey();
  const rows = await db.update(schema.pages).set({ accessMode: 'passkey', passkey: encryptSecret(pk), updatedAt: new Date() }).where(eq(schema.pages.id, page.id)).returning();
  res.json({ page: serialize(rows[0], await listFiles(page.id), { includePasskey: true }) });
});

router.delete('/:pageId', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  await store.deleteAll(page.pageId);
  await db.delete(schema.pages).where(eq(schema.pages.id, page.id)); // files + data cascade
  emitEvent({
    category: 'pages', type: 'page.deleted', severity: 'info',
    ...actorFromAuth(req.auth), ip: req.ip,
    targetType: 'page', targetId: page.pageId,
    message: `Page "${page.title}" deleted`
  }).catch(() => {});
  res.status(204).end();
});

// ── files ──
router.post('/:pageId/files', upload.array('files', config.pages.maxFilesPerUpload), async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'no files uploaded (field name "files")' });
  // Optional `paths` field (JSON array, file-order) carries the page-relative path for each
  // upload — needed for nested files, since multipart filenames are flattened to a basename.
  let paths = null;
  if (req.body && typeof req.body.paths === 'string') { try { paths = JSON.parse(req.body.paths); } catch { /* ignore */ } }
  const nameOf = (f, i) => (Array.isArray(paths) && paths[i] ? paths[i] : f.originalname);
  for (let i = 0; i < files.length; i++) {
    const name = nameOf(files[i], i);
    if (!pages.validFileName(name)) return res.status(400).json({ error: `invalid file name: ${name}` });
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = nameOf(f, i);
    const ct = f.mimetype && f.mimetype !== 'application/octet-stream' ? f.mimetype : pages.contentTypeFor(name);
    await store.putFile(page.pageId, name, f.buffer, ct);
    const existing = await db.select().from(schema.pageFiles).where(and(eq(schema.pageFiles.pageId, page.id), eq(schema.pageFiles.name, name))).limit(1);
    if (existing[0]) await db.update(schema.pageFiles).set({ size: f.size, contentType: ct, storageKey: store.keyFor(page.pageId, name), updatedAt: new Date() }).where(eq(schema.pageFiles.id, existing[0].id));
    else await db.insert(schema.pageFiles).values({ pageId: page.id, name, size: f.size, contentType: ct, storageKey: store.keyFor(page.pageId, name) });
  }
  res.json({ page: serialize(page, await listFiles(page.id), { includePasskey: true }) });
});

// text file get/put + delete by ?path= (supports nested names)
router.get('/:pageId/file', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const name = req.query.path;
  if (!pages.validFileName(name)) return res.status(400).json({ error: 'invalid path' });
  if (!pages.isTextFile(name)) return res.status(415).json({ error: 'not a text file' });
  const obj = await store.getFile(page.pageId, name);
  if (!obj) return res.status(404).json({ error: 'file not found' });
  if (obj.body.length > config.pages.editTextMaxBytes) return res.status(413).json({ error: 'file too large for the text editor' });
  res.json({ content: obj.body.toString('utf8') });
});

router.put('/:pageId/file', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const { path: name, content } = req.body || {};
  if (!pages.validFileName(name)) return res.status(400).json({ error: 'invalid path' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) is required' });
  if (Buffer.byteLength(content) > config.pages.editTextMaxBytes) return res.status(413).json({ error: 'content too large' });
  const ct = pages.contentTypeFor(name);
  await store.putFile(page.pageId, name, Buffer.from(content, 'utf8'), ct);
  const existing = await db.select().from(schema.pageFiles).where(and(eq(schema.pageFiles.pageId, page.id), eq(schema.pageFiles.name, name))).limit(1);
  if (existing[0]) await db.update(schema.pageFiles).set({ size: Buffer.byteLength(content), contentType: ct, updatedAt: new Date() }).where(eq(schema.pageFiles.id, existing[0].id));
  else await db.insert(schema.pageFiles).values({ pageId: page.id, name, size: Buffer.byteLength(content), contentType: ct, storageKey: store.keyFor(page.pageId, name) });
  res.json({ ok: true });
});

router.delete('/:pageId/file', async (req, res) => {
  const page = await loadPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const name = req.query.path;
  if (!pages.validFileName(name)) return res.status(400).json({ error: 'invalid path' });
  await store.deleteFile(page.pageId, name);
  await db.delete(schema.pageFiles).where(and(eq(schema.pageFiles.pageId, page.id), eq(schema.pageFiles.name, name)));
  res.status(204).end();
});

module.exports = router;
