'use strict';

// Everything served on an artifact's own host, <public_id>.<artifacts domain>:
// its files, the client library, the data API, live updates, and the end of the
// sign-in handoff. Mounted in server.js for artifact hosts only, ahead of every
// other router, and it ends in its own 404, so nothing else is reachable here.
//
// Reserved paths live under /_astrodock/. Everything else is the artifact's files.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { eq, and } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const M = require('../lib/artifacts/manifest');
const A = require('../lib/artifacts/access');
const records = require('../lib/artifacts/records');
const live = require('../lib/artifacts/live');
const store = require('../lib/pages-store');
const { errorPage } = require('../lib/auth-pages');
const { pageDataLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const CLIENT_JS = fs.readFileSync(path.join(__dirname, '..', 'assets', 'artifacts-client.js'), 'utf8');
const storeId = (publicId) => `artifacts/${publicId}`;

// Normalized manifests, keyed by artifact and its last change.
const manifestCache = new Map();
function manifestOf(artifact) {
  const hit = manifestCache.get(artifact.id);
  const stamp = new Date(artifact.updatedAt).getTime();
  if (hit && hit.stamp === stamp) return hit.manifest;
  const manifest = M.normalize(artifact.manifest);
  manifestCache.set(artifact.id, { stamp, manifest });
  return manifest;
}

function notFound(res) {
  return res.status(404).type('html').send(errorPage('Not Found', 'There is nothing at this address.'));
}

// Load the artifact and the viewer. Sets req.artifact, req.manifest, req.viewer.
async function resolve(req, res, next) {
  try {
    const publicId = config.artifactIdForHost(req.hostname);
    const artifact = publicId ? await A.loadArtifact(publicId) : null;
    if (!artifact || !artifact.isActive) return notFound(res);
    if (artifact.suspendedAt) {
      return res.status(451).type('html').send(errorPage('Unavailable', 'This artifact has been taken down.'));
    }
    req.artifact = artifact;
    req.manifest = manifestOf(artifact);
    req.viewer = { role: null, userId: null, email: null };
    const sess = A.readSession(req, artifact);
    if (sess) {
      const user = await A.loadUser(sess.sub);
      const role = user ? await A.roleFor(artifact, req.manifest, user) : null;
      if (role) req.viewer = { role, userId: user.id, email: user.email };
      else res.clearCookie(A.cookieName(), { path: '/', secure: config.tlsMode !== 'off' });
    }
    next();
  } catch (err) { next(err); }
}

const signedIn = (req) => !!req.viewer.role;
const isPublic = (req) => req.artifact.visibility === 'public';

// A write must come from the artifact's own page. Its session cookie is
// SameSite=Lax, which another artifact under the same registrable domain still
// counts as same-site, so the Origin header is the check that holds.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin && origin === config.artifactOrigin(req.artifact.publicId)) return next();
  return res.status(403).json({ error: 'Writes are accepted only from this artifact\'s own page.' });
}

function safeNext(n) {
  const s = String(n || '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

router.use(resolve);

// ── reserved: client and sign-in ───────────────────────────────────────────
router.get('/_astrodock/client.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('text/javascript').send(CLIENT_JS);
});

router.get('/_astrodock/signin', (req, res) => {
  const url = new URL(`${config.authBaseUrl()}/artifacts/signin`);
  url.searchParams.set('a', req.artifact.publicId);
  url.searchParams.set('next', safeNext(req.query.next));
  res.redirect(url.toString());
});

router.get('/_astrodock/callback', async (req, res, next) => {
  try {
    const user = await A.redeemGrant(req.artifact, String(req.query.code || ''));
    if (!user || !(await A.hasAccess(req.artifact, user))) {
      return res.status(401).type('html').send(errorPage('Sign-In Expired', 'That sign-in link has expired or was already used.', {
        action: { href: `/_astrodock/signin?next=${encodeURIComponent(safeNext(req.query.next))}`, label: 'Sign In Again' }
      }));
    }
    res.cookie(A.cookieName(), A.signSession(req.artifact, user), A.cookieOptions());
    res.set('Cache-Control', 'no-store');
    res.redirect(safeNext(req.query.next));
  } catch (err) { next(err); }
});

router.post('/_astrodock/signout', sameOrigin, (req, res) => {
  res.clearCookie(A.cookieName(), { path: '/', secure: config.tlsMode !== 'off' });
  res.status(204).end();
});

// ── data API ───────────────────────────────────────────────────────────────
const api = express.Router();
api.use(sameOrigin);
api.use(express.json({ limit: Math.max(config.artifacts.maxBlobBytes, config.artifacts.maxRecordBytes) + 16 * 1024 }));
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!signedIn(req) && !isPublic(req)) {
    return res.status(401).json({ error: 'Sign in to use this artifact.', signIn: '/_astrodock/signin' });
  }
  next();
});
api.use((req, res, next) => (req.method === 'GET' ? next() : pageDataLimiter(req, res, next)));

const send = (res, fn) => fn().catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[artifacts]', err.message);
  const body = { error: status >= 500 ? 'Something went wrong.' : err.message };
  if (err.problems) body.problems = err.problems;
  if (err.current !== undefined) body.current = err.current;
  res.status(status).json(body);
});

function whereOf(req) {
  if (!req.query.where) return undefined;
  let w;
  try { w = JSON.parse(String(req.query.where)); } catch { const e = new Error('where must be JSON'); e.status = 400; throw e; }
  if (!w || typeof w !== 'object' || Array.isArray(w)) { const e = new Error('where must be an object of field → value'); e.status = 400; throw e; }
  return w;
}

api.get('/me', (req, res) => {
  const v = req.viewer;
  res.json({
    signedIn: signedIn(req),
    email: v.email,
    role: v.role,
    roles: req.manifest.roles,
    artifact: { id: req.artifact.publicId, title: req.artifact.title, visibility: req.artifact.visibility },
    permissions: M.permissions(req.manifest, v)
  });
});

api.get('/c/:name', (req, res) => send(res, async () => {
  const list = await records.list(req.artifact, req.manifest, req.params.name, req.viewer, {
    where: whereOf(req), order: req.query.order, limit: req.query.limit, offset: req.query.offset
  });
  res.json({ records: list });
}));

api.post('/c/:name', (req, res) => send(res, async () => {
  res.status(201).json({ record: await records.create(req.artifact, req.manifest, req.params.name, req.body, req.viewer) });
}));

api.get('/c/:name/_count', (req, res) => send(res, async () => {
  res.json(await records.count(req.artifact, req.manifest, req.params.name, req.viewer, { by: req.query.by, where: whereOf(req) }));
}));

// Live updates, as server-sent events. Each change is checked against this
// viewer's own read rule before it is sent, and access is re-checked every
// heartbeat, so removing someone's share closes their stream.
api.get('/c/:name/_stream', async (req, res) => {
  const { artifact, manifest, viewer } = req;
  const c = manifest.collections[req.params.name];
  if (!c) return res.status(404).json({ error: `There is no collection "${req.params.name}".` });
  const g = M.grant(c.rules.read, manifest, viewer);
  if (!g) return res.status(403).json({ error: `Your role cannot read "${req.params.name}".` });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const visible = (row) => (c.scope !== 'per-user' || (viewer.userId && row.authorId === viewer.userId)) && M.recordMatches(g, row, viewer);
  const off = live.subscribe(artifact.id, req.params.name, (change) => {
    if (!visible(change.row)) return;
    const record = change.type === 'delete' ? { id: change.row.id } : records.toClient(change.row);
    res.write(`data: ${JSON.stringify({ type: change.type, record })}\n\n`);
  });
  const beat = setInterval(async () => {
    try {
      if (viewer.userId) {
        const user = await A.loadUser(viewer.userId);
        const [fresh] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifact.id)).limit(1);
        const still = user && fresh && fresh.isActive && !fresh.suspendedAt && fresh.sessionEpoch === artifact.sessionEpoch
          && await A.roleFor(fresh, manifest, user);
        if (!still) { res.end(); return; }
      }
      res.write(': ping\n\n');
    } catch { res.end(); }
  }, 25000);
  req.on('close', () => { off(); clearInterval(beat); });
});

api.get('/c/:name/:id', (req, res) => send(res, async () => {
  res.json({ record: await records.get(req.artifact, req.manifest, req.params.name, req.params.id, req.viewer) });
}));

api.patch('/c/:name/:id', (req, res) => send(res, async () => {
  res.json({ record: await records.update(req.artifact, req.manifest, req.params.name, req.params.id, req.body, req.viewer) });
}));

api.delete('/c/:name/:id', (req, res) => send(res, async () => {
  res.json(await records.remove(req.artifact, req.manifest, req.params.name, req.params.id, req.viewer));
}));

api.get('/b/:name', (req, res) => send(res, async () => {
  res.json(await records.getBlob(req.artifact, req.manifest, req.params.name, req.viewer));
}));

api.put('/b/:name', (req, res) => send(res, async () => {
  const body = req.body || {};
  res.json(await records.setBlob(req.artifact, req.manifest, req.params.name, body.data, body.version, req.viewer));
}));

api.use((req, res) => res.status(404).json({ error: 'No such endpoint.' }));
router.use('/_astrodock/api', api);
router.use('/_astrodock', (req, res) => notFound(res));

// ── files ──────────────────────────────────────────────────────────────────
async function findFile(artifact, name) {
  const [f] = await db.select().from(schema.artifactFiles)
    .where(and(eq(schema.artifactFiles.artifactId, artifact.id), eq(schema.artifactFiles.name, name))).limit(1);
  return f || null;
}

router.get('*', async (req, res, next) => {
  try {
    const { artifact } = req;
    if (!signedIn(req) && !isPublic(req)) {
      return res.redirect(`/_astrodock/signin?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    }
    let name;
    try { name = decodeURIComponent(req.path.replace(/^\/+/, '')); } catch { return notFound(res); }
    if (name === '' || name.endsWith('/')) name += name === '' ? artifact.entryFile : 'index.html';
    if (name.includes('..') || name.includes('\\')) return notFound(res);
    let file = await findFile(artifact, name);
    // A path with no extension is a page of a single-page app: serve the entry file.
    if (!file && !/\.[A-Za-z0-9]{1,8}$/.test(name)) file = await findFile(artifact, `${name}/index.html`) || await findFile(artifact, artifact.entryFile);
    if (!file) return notFound(res);
    const obj = await store.getFile(storeId(artifact.publicId), file.name);
    if (!obj) return notFound(res);
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    res.type(file.contentType).send(obj.body);
  } catch (err) { next(err); }
});

router.use((req, res) => notFound(res));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[artifacts]', err.message);
  res.status(err.status || 500).type('html').send(errorPage('Something Went Wrong', 'This artifact could not be loaded.'));
});

module.exports = router;
module.exports.storeId = storeId;
module.exports._manifestCache = manifestCache;
