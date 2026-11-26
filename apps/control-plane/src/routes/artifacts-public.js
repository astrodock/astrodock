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
const logs = require('../lib/artifacts/logs');
const uploads = require('../lib/artifacts/uploads');
const egress = require('../lib/artifacts/egress');
const multer = require('multer');
const { emitEvent } = require('../lib/events');
const store = require('../lib/pages-store');
const { errorPage, shell, esc } = require('../lib/auth-pages');
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
  res.locals.error = `cross-origin write refused (Origin: ${origin || 'none'})`;
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
      logs.signin(req.artifact, req, user ? user.email : '', 'grant_failed');
      return res.status(401).type('html').send(errorPage('Sign-In Expired', 'That sign-in link has expired or was already used.', {
        action: { href: `/_astrodock/signin?next=${encodeURIComponent(safeNext(req.query.next))}`, label: 'Sign In Again' }
      }));
    }
    res.cookie(A.cookieName(), A.signSession(req.artifact, user), A.cookieOptions());
    logs.signin(req.artifact, req, user.email, 'grant_ok');
    res.set('Cache-Control', 'no-store');
    res.redirect(safeNext(req.query.next));
  } catch (err) { next(err); }
});

router.post('/_astrodock/signout', sameOrigin, (req, res) => {
  res.clearCookie(A.cookieName(), { path: '/', secure: config.tlsMode !== 'off' });
  res.status(204).end();
});

// ── Report a Problem (linked from the footer client.js adds to every page) ──
// Open to anyone who reaches the host, signed in or not: someone sent a link
// to a harmful page should be able to say so without an account.
const REPORT_KINDS = { broken: 'Something Is Not Working', abuse: 'This Is Harmful or Abusive' };
function reportPage(artifact, { done = false, error = '' } = {}) {
  if (done) {
    return shell('Report Sent', `<div class="heading"><h1>Thank You</h1><p class="sub">Your report about ${esc(artifact.title || 'this artifact')} was sent.</p></div>
<a class="btn secondary" href="/">Back</a>`);
  }
  return shell('Report a Problem', `<div class="heading"><h1>Report a Problem</h1><p class="sub">About ${esc(artifact.title || 'this artifact')}</p></div>
${error ? `<div class="err" role="alert"><span>${esc(error)}</span></div>` : ''}
<form method="post" action="/_astrodock/report">
<div class="field"><label><input type="radio" name="kind" value="broken" checked style="width:auto;height:auto;box-shadow:none"> ${REPORT_KINDS.broken}</label>
<label><input type="radio" name="kind" value="abuse" style="width:auto;height:auto;box-shadow:none"> ${REPORT_KINDS.abuse}</label></div>
<div class="field"><label for="message">What Happened</label>
<textarea id="message" name="message" rows="5" maxlength="4000" required style="width:100%;padding:10px 12px;border:0;border-radius:0;font:inherit;box-shadow:inset 0 0 0 1px var(--line-input)"></textarea></div>
<button type="submit">Send Report</button>
</form>
<p class="muted">A report that this is not working goes to the person who made it. A report that it is harmful goes to the people who run this platform.</p>`);
}

router.get('/_astrodock/report', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(reportPage(req.artifact));
});

router.post('/_astrodock/report', sameOrigin, pageDataLimiter, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res, next) => {
  try {
    const kind = REPORT_KINDS[req.body.kind] ? req.body.kind : 'broken';
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).type('html').send(reportPage(req.artifact, { error: 'Say what happened.' }));
    const row = await logs.report(req.artifact, req, { kind, message, email: req.viewer.email || '' });
    if (kind === 'abuse') {
      emitEvent({
        category: 'pages', type: 'artifact.reported', severity: 'warning', actorType: 'user', actor: req.viewer.email || 'anonymous',
        ip: req.ip, targetType: 'artifact', targetId: req.artifact.publicId,
        message: `Artifact "${req.artifact.title}" reported as harmful`, meta: { reportId: row.id, artifactId: req.artifact.publicId }
      }).catch(() => {});
    }
    res.type('html').send(reportPage(req.artifact, { done: true }));
  } catch (err) { next(err); }
});

// ── data API ───────────────────────────────────────────────────────────────
const api = express.Router();

// What a data call was, from its path: { op, target, recordId }.
function describe(req) {
  const parts = req.path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts[0] === 'me') return { op: 'me' };
  if (parts[0] === '_log') return { op: 'log' };
  if (parts[0] === 'b') return { op: req.method === 'GET' ? 'blob.get' : 'blob.set', target: parts[1] || '' };
  if (parts[0] === 'c') {
    const target = parts[1] || '';
    if (parts[2] === '_count') return { op: 'count', target };
    if (parts[2] === '_stream') return { op: 'stream', target };
    if (parts[3] === 'files') {
      const op = req.method === 'POST' ? 'attach' : req.method === 'DELETE' ? 'detach' : 'file';
      return { op, target, recordId: parts[2] };
    }
    if (parts[2]) return { op: { GET: 'get', PATCH: 'update', DELETE: 'delete' }[req.method] || req.method.toLowerCase(), target, recordId: parts[2] };
    return { op: req.method === 'GET' ? 'list' : 'create', target };
  }
  return { op: 'unknown', target: parts.join('/') };
}

// Writes and failures in full; successful reads as hourly counts; failures
// other than a plain "not signed in" also go to the artifact's error list.
api.use((req, res, next) => {
  const started = Date.now();
  // Read the path now: by the time the response finishes, Express may have
  // put the full URL back on req.
  const d = describe(req);
  res.on('finish', () => {
    if (d.op === 'log') return;
    const { artifact, viewer } = req;
    const status = res.statusCode;
    if (req.method === 'GET' && status < 400) { logs.countRead(artifact, viewer, d.target || d.op); return; }
    const error = res.locals.error || '';
    logs.api(artifact, req, viewer, { ...d, status, durationMs: Date.now() - started, error });
    if (status >= 400 && status !== 401) {
      logs.error(artifact, {
        kind: status >= 500 ? 'server' : 'api',
        message: `${status} ${d.op}${d.target ? ` ${d.target}` : ''}: ${error}`,
        path: req.get('referer') ? (() => { try { return new URL(req.get('referer')).pathname; } catch { return ''; } })() : '',
        userAgent: req.get('user-agent') || '', email: viewer.email || ''
      });
    }
  });
  next();
});

api.use(sameOrigin);
api.use(express.json({ limit: Math.max(config.artifacts.maxBlobBytes, config.artifacts.maxRecordBytes) + 16 * 1024 }));
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!signedIn(req) && !isPublic(req)) {
    res.locals.error = 'not signed in';
    return res.status(401).json({ error: 'Sign in to use this artifact.', signIn: '/_astrodock/signin' });
  }
  next();
});
api.use((req, res, next) => (req.method === 'GET' ? next() : pageDataLimiter(req, res, next)));

const send = (res, fn) => fn().catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[artifacts]', err.message);
  const body = { error: status >= 500 ? 'Something went wrong.' : err.message };
  res.locals.error = body.error;
  if (err.problems) body.problems = err.problems;
  if (err.current !== undefined) body.current = err.current;
  if (err.code) body.code = err.code;
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

// Files attached to a record. Downloads carry a sandbox policy, and anything
// but a plain image or PDF is sent as a download, so an uploaded page cannot
// run as this artifact.
const attachUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.artifacts.maxFileBytes, files: 1 } }).single('file');
api.post('/c/:name/:id/files', (req, res, next) => attachUpload(req, res, (err) => {
  if (err) { res.locals.error = err.message; return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message }); }
  next();
}), (req, res) => send(res, async () => {
  res.status(201).json({ file: await uploads.attach(req.artifact, req.manifest, req.params.name, req.params.id, req.file, req.viewer) });
}));

api.get('/c/:name/:id/files/:fileId', (req, res) => send(res, async () => {
  if (await egress.over(req.artifact)) { const e = new Error('This artifact has used its bandwidth for the month.'); e.status = 429; throw e; }
  const f = await uploads.read(req.artifact, req.manifest, req.params.name, req.params.id, req.params.fileId, req.viewer);
  res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.set('Cache-Control', 'private, no-cache');
  const disp = f.inline ? 'inline' : 'attachment';
  res.set('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(f.upload.name)}`);
  res.type(f.inline ? f.upload.contentType : 'application/octet-stream').send(f.body);
  egress.add(req.artifact, f.body.length);
}));

api.delete('/c/:name/:id/files/:fileId', (req, res) => send(res, async () => {
  res.json(await uploads.detach(req.artifact, req.manifest, req.params.name, req.params.id, req.params.fileId, req.viewer));
}));

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

// Errors from the page itself, sent by client.js: uncaught errors, rejected
// promises, console.error and failed requests. A few per call, within an
// hourly budget per artifact, grouped by the server.
api.post('/_log', (req, res) => {
  const list = Array.isArray(req.body && req.body.reports) ? req.body.reports.slice(0, 10) : [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (!logs.takeReportBudget(req.artifact.id)) break;
    logs.error(req.artifact, {
      kind: ['error', 'rejection', 'console', 'network'].includes(r.kind) ? r.kind : 'error',
      message: r.message, source: r.source, stack: r.stack, path: r.path,
      userAgent: req.get('user-agent') || '', email: req.viewer.email || ''
    });
  }
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: 'No such endpoint.' }));
router.use('/_astrodock/api', api);
router.use('/_astrodock', (req, res) => notFound(res));

// ── files ──────────────────────────────────────────────────────────────────
// Every HTML page gets the client script at the top of <head>, so error
// reporting and the Report a Problem link are there even when the page does
// not load the client itself. client.js ignores a second copy.
const CLIENT_TAG = '<script src="/_astrodock/client.js"></script>';
function injectClient(html) {
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + CLIENT_TAG + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d.index + d[0].length) + CLIENT_TAG + html.slice(d.index + d[0].length);
  return CLIENT_TAG + html;
}

async function findFile(artifact, name) {
  const [f] = await db.select().from(schema.artifactFiles)
    .where(and(eq(schema.artifactFiles.artifactId, artifact.id), eq(schema.artifactFiles.name, name))).limit(1);
  return f || null;
}

router.get('*', async (req, res, next) => {
  try {
    const { artifact } = req;
    if (!signedIn(req) && !isPublic(req)) {
      logs.view(artifact, req, req.viewer, req.originalUrl, 302);
      return res.redirect(`/_astrodock/signin?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    }
    let name;
    try { name = decodeURIComponent(req.path.replace(/^\/+/, '')); } catch { return notFound(res); }
    if (name === '' || name.endsWith('/')) name += name === '' ? artifact.entryFile : 'index.html';
    if (name.includes('..') || name.includes('\\')) return notFound(res);
    const paused = await egress.over(artifact);
    if (paused) {
      return res.status(429).type('html').send(errorPage('Paused for the Month', 'This public artifact has used its bandwidth for the month. It comes back when the month turns.'));
    }
    let file = await findFile(artifact, name);
    // A path with no extension is a page of a single-page app: serve the entry file.
    if (!file && !/\.[A-Za-z0-9]{1,8}$/.test(name)) file = await findFile(artifact, `${name}/index.html`) || await findFile(artifact, artifact.entryFile);
    if (!file) return notFound(res);
    const obj = await store.getFile(storeId(artifact.publicId), file.name);
    if (!obj) return notFound(res);
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    if (/^text\/html/i.test(file.contentType)) {
      logs.view(artifact, req, req.viewer, req.originalUrl, 200);
      const html = injectClient(obj.body.toString('utf8'));
      egress.add(artifact, Buffer.byteLength(html));
      return res.type(file.contentType).send(html);
    }
    egress.add(artifact, obj.body.length);
    res.type(file.contentType).send(obj.body);
  } catch (err) { next(err); }
});

router.use((req, res) => notFound(res));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[artifacts]', err.message);
  if (req.artifact) logs.error(req.artifact, { kind: 'server', message: `500 ${req.method} ${req.path}: the page could not be served`, email: req.viewer ? req.viewer.email : '' });
  res.status(err.status || 500).type('html').send(errorPage('Something Went Wrong', 'This artifact could not be loaded.'));
});

module.exports = router;
module.exports.storeId = storeId;
module.exports._manifestCache = manifestCache;
module.exports.injectClient = injectClient;
module.exports.describe = describe;
