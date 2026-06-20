'use strict';

// Public serving for the pages.<base-domain> host: serves page files from the object
// store, enforces the per-page access gate (public / passkey / platform login), and
// exposes the small per-page JSON data blob. Mounted only for the pages host; ends in a
// 404 so admin paths are never reachable here. Cookies are parsed app-level upstream.

const express = require('express');
const { eq, and, isNull } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { decryptSecret } = require('../lib/crypto');
const { verifyPassword } = require('../lib/passwords');
const { getSetting } = require('../lib/settings');
const { pageDataLimiter, pageLoginLimiter } = require('../middleware/rateLimiter');
const P = require('../lib/pages');

// strict routing so "/:pageId" (no slash) redirects, while "/:pageId/" serves the entry
// file (otherwise the non-strict bare route swallows the trailing-slash form → 301 loop).
const router = express.Router({ strict: true });

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadPage(pageId) {
  const rows = await db.select().from(schema.pages).where(eq(schema.pages.pageId, pageId)).limit(1);
  return rows[0] || null;
}

// Load + activity gate. Sets req.page or 404s.
async function withPage(req, res, next) {
  const page = await loadPage(req.params.pageId);
  if (!page || !page.isActive) return res.status(404).type('html').send(notFoundHtml());
  req.page = page;
  next();
}

// Access gate. Returns { ok, user } ; on !ok it has already responded (prompt/login/401).
// `json` = true for API calls (return JSON 401 instead of an HTML prompt/form).
function gate(page, req, res, { json = false } = {}) {
  if (page.accessMode === 'public') return { ok: true, user: null };

  if (page.accessMode === 'passkey') {
    const real = decryptSecret(page.passkey);
    const cookie = req.cookies?.[P.PASSKEY_COOKIE(page.pageId)];
    if (req.query.key && req.query.key === real) {
      res.cookie(P.PASSKEY_COOKIE(page.pageId), P.passkeyToken(page.pageId, real), cookieOpts(true));
      return { ok: true, user: null };
    }
    if (P.passkeyValid(page.pageId, real, cookie)) return { ok: true, user: null };
    if (json) { res.status(401).json({ error: 'passkey required' }); return { ok: false }; }
    res.status(401).type('html').send(passkeyPromptHtml(page));
    return { ok: false };
  }

  // platform: require a logged-in Astrodock user, honor the per-page allowlist
  const sess = P.verifySession(req.cookies?.[P.SESSION_COOKIE]);
  if (sess && allowed(page, sess.email)) return { ok: true, user: sess };
  if (json) { res.status(401).json({ error: 'login required' }); return { ok: false }; }
  res.status(401).type('html').send(loginFormHtml(page, sess ? 'Your account does not have access to this page.' : ''));
  return { ok: false };
}
function allowed(page, email) {
  const list = page.allowlist || [];
  return list.length === 0 || list.includes(String(email).toLowerCase());
}

// IP truncation for the "truncated" privacy mode (zero the last IPv4 octet / keep
// the first three IPv6 groups).
function truncateIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
  const parts = ip.split('.');
  if (parts.length === 4) { parts[3] = '0'; return parts.join('.'); }
  return ip;
}

// Best-effort per-request access log. Honors logging.page_view_ip (full|truncated|off).
async function recordView(page, req, name, status, user) {
  try {
    const mode = await getSetting('logging.page_view_ip', 'full');
    let ip = req.ip || '';
    if (mode === 'off') ip = '';
    else if (mode === 'truncated') ip = truncateIp(ip);
    await db.insert(schema.pageViews).values({
      pageId: page.id, path: name, ip,
      userAgent: (req.get('user-agent') || '').slice(0, 300),
      referrer: (req.get('referer') || '').slice(0, 400),
      userId: user && user.sub ? user.sub : null,
      status
    });
  } catch { /* logging must never break serving */ }
}
function cookieOpts(httpOnly) {
  return { httpOnly: !!httpOnly, sameSite: 'lax', secure: config.tlsMode !== 'off', maxAge: 7 * 864e5, path: '/' };
}

// ── platform login / logout ──
router.post('/:pageId/_login', pageLoginLimiter, express.urlencoded({ extended: false }), withPage, async (req, res) => {
  if (req.page.accessMode !== 'platform') return res.status(400).type('html').send('Not a login-protected page.');
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];
  const ok = user && user.isActive && await verifyPassword(password, user.passwordHash);
  if (!ok || !allowed(req.page, email)) {
    return res.status(401).type('html').send(loginFormHtml(req.page, 'Invalid credentials or no access.'));
  }
  res.cookie(P.SESSION_COOKIE, P.signSession(user), cookieOpts(true));
  res.redirect(`/${req.page.pageId}/`);
});

router.post('/:pageId/_logout', (req, res) => {
  res.clearCookie(P.SESSION_COOKIE, { path: '/' });
  res.redirect(`/${req.params.pageId}/`);
});

// ── per-page JSON data blob ──
router.get('/:pageId/_data', withPage, async (req, res) => {
  const page = req.page;
  if (page.dataMode === 'none') return res.status(404).json({ error: 'this page has no data store' });
  const g = gate(page, req, res, { json: true });
  if (!g.ok) return;
  const userId = page.dataMode === 'per-user' ? g.user.sub : null;
  const row = await loadData(page.id, userId);
  res.json({ data: row ? row.data : {}, version: row ? row.version : 0 });
});

router.put('/:pageId/_data', pageDataLimiter, withPage, express.json({ limit: config.pages.dataMax }), async (req, res) => {
  const page = req.page;
  if (page.dataMode === 'none') return res.status(404).json({ error: 'this page has no data store' });
  const g = gate(page, req, res, { json: true });
  if (!g.ok) return;
  const body = req.body || {};
  if (!('data' in body)) return res.status(400).json({ error: 'body must be { data, version? }' });
  if (Buffer.byteLength(JSON.stringify(body.data)) > config.pages.dataMaxBytes) {
    return res.status(413).json({ error: `data too large (max ${config.pages.dataMax})` });
  }
  const userId = page.dataMode === 'per-user' ? g.user.sub : null;
  const existing = await loadData(page.id, userId);
  if (existing && body.version !== undefined && Number(body.version) !== existing.version) {
    return res.status(409).json({ error: 'version conflict', currentVersion: existing.version });
  }
  if (existing) {
    const rows = await db.update(schema.pageData)
      .set({ data: body.data, version: existing.version + 1, updatedAt: new Date() })
      .where(eq(schema.pageData.id, existing.id)).returning();
    return res.json({ ok: true, version: rows[0].version });
  }
  const rows = await db.insert(schema.pageData).values({ pageId: page.id, userId, data: body.data, version: 1 }).returning();
  res.json({ ok: true, version: rows[0].version });
});

function loadData(pageUuid, userId) {
  const cond = userId == null
    ? and(eq(schema.pageData.pageId, pageUuid), isNull(schema.pageData.userId))
    : and(eq(schema.pageData.pageId, pageUuid), eq(schema.pageData.userId, userId));
  return db.select().from(schema.pageData).where(cond).limit(1).then((r) => r[0] || null);
}

// ── serve files (entry on "/", any file on "/*") ──
router.get('/:pageId', (req, res) => res.redirect(301, `/${req.params.pageId}/`));

router.get('/:pageId/*', withPage, async (req, res) => {
  const page = req.page;
  const rest = req.params[0] || '';
  const isEntry = rest === '' || rest === page.entryFile;
  const name = rest === '' ? page.entryFile : rest;
  if (!P.validFileName(name)) return res.status(404).type('html').send(notFoundHtml());

  const g = gate(page, req, res, { json: false });
  if (!g.ok) return;

  const obj = await store().getFile(page.pageId, name).catch(() => null);
  if (!obj) return res.status(404).type('html').send(notFoundHtml());

  if (isEntry) {
    db.update(schema.pages).set({ views: page.views + 1, lastViewedAt: new Date() }).where(eq(schema.pages.id, page.id)).catch(() => {});
  }
  recordView(page, req, name, 200, g.user).catch(() => {});
  res.setHeader('Content-Type', obj.contentType || P.contentTypeFor(name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(obj.body);
});

// lazily require the store so unit tests that don't touch files don't need it
function store() { return require('../lib/pages-store'); }

// anything else on the pages host → 404 (admin paths are never served here)
router.use((req, res) => res.status(404).type('html').send(notFoundHtml()));

// ── tiny inline HTML ──
function shell(title, body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:380px;margin:14vh auto;padding:0 20px;color:#1c2230}
h1{font-size:20px}input{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:8px;font-size:15px;box-sizing:border-box}
button{padding:10px 16px;border:0;border-radius:8px;background:#5145e6;color:#fff;font-size:15px;cursor:pointer}
.err{color:#c0392b;font-size:14px}</style>${body}`;
}
function passkeyPromptHtml(page) {
  return shell('Protected page', `<h1>This page is protected</h1>
<form method="GET" action="/${page.pageId}/"><input name="key" type="password" placeholder="Passkey" autofocus required>
<button type="submit">Unlock</button></form>`);
}
function loginFormHtml(page, err) {
  return shell('Sign in', `<h1>Sign in to view this page</h1>
${err ? `<p class=err>${esc(err)}</p>` : ''}
<form method="POST" action="/${page.pageId}/_login"><input name="email" type="email" placeholder="Email" autofocus required>
<input name="password" type="password" placeholder="Password" required><button type="submit">Sign in</button></form>`);
}
function notFoundHtml() { return shell('Not found', '<h1>404 — not found</h1><p>This page doesn’t exist or isn’t available.</p>'); }

module.exports = router;
