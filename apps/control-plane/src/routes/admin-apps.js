'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { eq, and, desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireScope, requirePermission, tokenAllowsApp } = require('../middleware/auth');
const { requireRecentAuth } = require('../lib/sessions');
const { deployLimiter } = require('../middleware/rateLimiter');
const { getAppBySlug, getAppEnvVars, serializeApp, serializeEnvVar } = require('../lib/apps');
const { applyManifest } = require('../lib/apply');
const { computeEnv, computeMissingRequired } = require('../lib/env-compute');
const { provisionApp, reloadCaddyFromDb } = require('../provision');
const { runner } = require('../runner/client');
const { generateAppSecret, generateWebhookSecret } = require('../lib/ids');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const { dropDatabase } = require('../provision/database');
const { listRepos, createWebhook, deleteWebhook } = require('../lib/github');
const domainsLib = require('../lib/domains');
const { emitEvent, actorFromAuth } = require('../lib/events');
const oauth = require('../lib/oauth');

// Subdomains may not collide with platform hosts or be invalid DNS labels.
//
// Each of these is refused for a reason worth stating, because "reserved" on its
// own tells someone nothing about whether the name will ever be available. The
// list is served to the dashboard so the form can show it up front, rather than
// letting people find out one rejected name at a time.
const RESERVED_SUBDOMAINS = new Map([
  ['admin', 'the dashboard'],
  ['pages', 'hosted Pages'],
  ['auth', 'reserved for hosted sign-in'],
  ['api', 'reserved for the platform API'],
  ['www', 'redirects to your main address — set that under Settings'],
  ['mail', 'clashes with mail servers and MX records'],
  ['ftp', 'clashes with file-transfer conventions'],
  [config.adminSubdomain, 'the dashboard'],
  [config.pages.subdomain, 'hosted Pages']
].filter(([k]) => k));

function reservedReason(v) { return RESERVED_SUBDOMAINS.get(v) || null; }

function validSubdomain(v) {
  return typeof v === 'string'
    && v.length <= 40
    && /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(v)   // valid label, no leading/trailing hyphen
    && !RESERVED_SUBDOMAINS.has(v);
}

const router = express.Router();
router.use(requireScope('apps:read'));

// Enforce per-app token scope for every /:slug route (params aren't available in
// the router-level use() above, but router.param runs once :slug is matched).
router.param('slug', (req, res, next, slug) => {
  if (req.auth && !tokenAllowsApp(req.auth, slug)) {
    return res.status(403).json({ error: `Token is not scoped to app "${slug}"` });
  }
  next();
});

const scheme = () => (config.tlsMode === 'off' ? 'http' : 'https');

// ── must come before /:slug ───────────────────────────────────────────────────
router.get('/github/repos', async (req, res) => {
  if (!config.github.pat) return res.status(422).json({ error: 'GitHub PAT not configured (ASTRODOCK_GITHUB_PAT)' });
  try { res.json({ repos: await listRepos() }); }
  catch (err) { res.status(500).json({ error: `Failed to list repos: ${err.message}` }); }
});

router.get('/status/all', async (req, res) => {
  const r = await runner.statusAll().catch(() => ({ status: 200, body: { statuses: {} } }));
  const all = r.body?.statuses || {};
  // a per-app-scoped token only sees its own apps
  const statuses = Object.fromEntries(Object.entries(all).filter(([slug]) => tokenAllowsApp(req.auth, slug)));
  res.json({ statuses });
});

// ── apply a manifest (CLI `apply`) ──────────────────────────────────────────────
router.post('/apply', requirePermission('apps:write'), async (req, res) => {
  const manifest = req.body?.manifest || req.body;
  const prune = !!(req.body?.prune || req.query.prune);
  if (manifest && manifest.slug && !tokenAllowsApp(req.auth, manifest.slug)) {
    return res.status(403).json({ error: `Token is not scoped to app "${manifest.slug}"` });
  }
  try {
    const { app, created, appSecret: newAppSecret } = await applyManifest(manifest, { prune });

    // Optionally connect repo (githubRepo may come from manifest.source).
    const githubRepo = manifest?.source?.githubRepo;
    let repoConnected = false;
    if (githubRepo && config.github.pat && githubRepo !== app.githubRepo) {
      try { await connectRepoInternal(app, githubRepo, app.branch, app.repoPath); repoConnected = true; }
      catch (e) { /* surfaced in response */ res.locals.repoError = e.message; }
    }

    // Provision (DB/storage/Caddy).
    const { app: provisioned, results } = await provisionApp(await getAppBySlug(app.slug));

    res.status(created ? 201 : 200).json({
      created,
      app: serializeApp(provisioned),
      appSecret: created ? newAppSecret : undefined, // shown once, plaintext
      repoConnected,
      repoError: res.locals.repoError,
      provision: results
    });
  } catch (err) {
    if (err.status === 400 && err.errors) return res.status(400).json({ error: err.message, errors: err.errors });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  let apps = await db.select().from(schema.apps).orderBy(schema.apps.name);
  // per-app-scoped tokens only see their apps
  apps = apps.filter((a) => tokenAllowsApp(req.auth, a.slug));
  res.json({ apps: apps.map(serializeApp) });
});

router.get('/:slug', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const envVars = await getAppEnvVars(app.id);
  res.json({
    app: serializeApp(app),
    envVars: envVars.map(serializeEnvVar),
    missingRequired: computeMissingRequired(app, envVars)
  });
});

// Manual create (admin UI) — builds a manifest from the body and applies it.
router.post('/', requirePermission('apps:write'), async (req, res) => {
  const b = req.body || {};
  if (b.slug && !tokenAllowsApp(req.auth, b.slug)) {
    return res.status(403).json({ error: `Token is not scoped to app "${b.slug}"` });
  }
  if (b.subdomain !== undefined && !validSubdomain(String(b.subdomain))) {
    const why = reservedReason(String(b.subdomain || '').toLowerCase());
    return res.status(400).json({
      error: why
        ? `"${b.subdomain}" is reserved — it is used for ${why}.`
        : 'That subdomain is not valid. Use letters, numbers and hyphens, starting and ending with a letter or number.',
      reserved: [...RESERVED_SUBDOMAINS.keys()]
    });
  }
  const manifest = {
    schemaVersion: '1',
    slug: b.slug, name: b.name, subdomain: b.subdomain, description: b.description || '',
    source: { branch: b.branch || 'main', repoPath: b.repoPath || '' },
    runtime: { type: b.runtimeType || b.runtime?.type || 'node', spa: b.spa !== false },
    auth: { mode: b.authMode || b.auth?.mode || 'platform' },
    database: { mode: b.databaseMode || b.database?.mode || 'none' },
    storage: { mode: b.storageMode || b.storage?.mode || 'none' },
    env: []
  };
  try {
    const { app, created, appSecret: newAppSecret } = await applyManifest(manifest);
    if (!created) return res.status(409).json({ error: 'An app with this slug already exists' });
    res.status(201).json({ app: serializeApp(app), appSecret: newAppSecret });
  } catch (err) {
    if (err.errors) return res.status(err.status || 400).json({ error: err.message, errors: err.errors });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update structural fields / modes.
// Structural fields that flow into a shell (git/docker) or the generated Caddyfile MUST be
// validated here too — PATCH must not be a bypass around the manifest schema.
const PATCH_VALIDATORS = {
  subdomain: validSubdomain,
  branch: (v) => /^[A-Za-z0-9._/-]+$/.test(v) && v.length <= 200,
  repoPath: (v) => /^[A-Za-z0-9._/-]*$/.test(v) && !v.includes('..') && v.length <= 200,
  dockerfile: (v) => /^[A-Za-z0-9._/-]+$/.test(v) && !v.includes('..') && v.length <= 200,
  runtimeType: (v) => v === 'node' || v === 'docker',
  authMode: (v) => v === 'platform' || v === 'public',
  databaseMode: (v) => ['internal', 'external', 'none'].includes(v),
  storageMode: (v) => ['internal', 'external', 'none'].includes(v),
  buildCommand: (v) => typeof v === 'string' && v.length <= 500,
  spa: (v) => v === 'true' || v === 'false',
  // Interpolated into the sign-in page's stylesheet and an <img src>. Rejected
  // here as well as at render time — a bad value should never reach the column.
  brandColor: (v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v),
  logoUrl: (v) => v === '' || (/^https:\/\/[^\s"'<>]+$/.test(v) && v.length <= 500)
};

router.patch('/:slug', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const b = req.body || {};
  const update = { updatedAt: new Date() };
  const map = {
    name: 'name', description: 'description',
    authMode: 'authMode', databaseMode: 'databaseMode', storageMode: 'storageMode',
    runtimeType: 'runtimeType', buildCommand: 'buildCommand', dockerfile: 'dockerfile', spa: 'spa',
    branch: 'branch', repoPath: 'repoPath', subdomain: 'subdomain',
    brandColor: 'brandColor', logoUrl: 'logoUrl'
  };
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    const check = PATCH_VALIDATORS[k];
    if (check && !check(String(b[k]))) return res.status(400).json({ error: `invalid value for "${k}"` });
    update[col] = b[k];
  }
  // changing the subdomain must not collide with another app
  if (update.subdomain && update.subdomain !== app.subdomain) {
    const clash = await db.select().from(schema.apps).where(eq(schema.apps.subdomain, update.subdomain)).limit(1);
    if (clash[0]) return res.status(409).json({ error: 'subdomain already in use' });
  }
  const rows = await db.update(schema.apps).set(update).where(eq(schema.apps.id, app.id)).returning();

  // Three of these fields are written into the generated Caddyfile. Without this
  // the change sat in the database until the reconciler's next pass — so renaming
  // a subdomain appeared to work and the old address kept serving.
  if (['subdomain', 'spa', 'runtimeType'].some((k) => b[k] !== undefined)) {
    await reloadCaddyFromDb().catch(() => {});
  }
  res.json({ app: serializeApp(rows[0]) });
});

router.delete('/:slug', requirePermission('apps:delete'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const purge = !!(req.query.purge || req.body?.purge); // also drop internal data

  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  try { await runner.remove(app.slug); } catch { /* best effort */ }

  if (purge) {
    if (app.databaseMode === 'internal') { try { await dropDatabase(app); } catch (e) { console.error('[delete] drop db failed:', e.message); } }
    if (app.storageMode === 'internal') { try { await runner.dropStorage(app.slug); } catch (e) { console.error('[delete] drop storage failed:', e.message); } }
  }

  await db.delete(schema.deployments).where(eq(schema.deployments.appSlug, app.slug));
  await db.delete(schema.appHealth).where(eq(schema.appHealth.slug, app.slug)).catch(() => {});
  await db.delete(schema.apps).where(eq(schema.apps.id, app.id)); // env vars cascade
  await reloadCaddyFromDb();

  if (!purge && (app.databaseMode === 'internal' || app.storageMode === 'internal')) {
    console.log(`[delete] ${app.slug}: internal data retained (pass ?purge=true to drop the DB/storage too)`);
  }
  res.status(204).end();
});

router.post('/:slug/rotate-secret', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const appSecret = generateAppSecret();
  await db.update(schema.apps).set({ appSecret: encryptSecret(appSecret), updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  res.json({ appSecret, note: 'Redeploy the app for the new secret to take effect.' });
});

// ── provisioning ────────────────────────────────────────────────────────────────
router.post('/:slug/provision', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    const { app: updated, results } = await provisionApp(app);
    res.json({ message: 'Provisioned', app: serializeApp(updated), details: results });
  } catch (err) {
    res.status(500).json({ error: `Provisioning failed: ${err.message}` });
  }
});

// ── GitHub repo connect / disconnect ──────────────────────────────────────────────
async function connectRepoInternal(app, githubRepo, branch, repoPath) {
  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  const webhookSecret = generateWebhookSecret();
  const callbackUrl = `${scheme()}://${config.adminSubdomain}.${config.baseDomain}/webhooks/github`;
  const webhookId = await createWebhook(githubRepo, callbackUrl, webhookSecret);
  await db.update(schema.apps).set({
    githubRepo, branch: branch || 'main', repoPath: repoPath || '', webhookId,
    webhookSecret: encryptSecret(webhookSecret), updatedAt: new Date() // encrypted at rest like every other generated secret
  }).where(eq(schema.apps.id, app.id));
}

router.post('/:slug/connect-repo', requirePermission('apps:write'), async (req, res) => {
  const { githubRepo, branch, repoPath } = req.body || {};
  if (!githubRepo) return res.status(400).json({ error: 'githubRepo is required (e.g. "owner/repo")' });
  // these get interpolated into shell (git clone) on the runner — keep them metachar-free
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) return res.status(400).json({ error: 'githubRepo must be "owner/repo"' });
  if (branch && !/^[A-Za-z0-9._/-]+$/.test(branch)) return res.status(400).json({ error: 'invalid branch name' });
  if (repoPath && (!/^[A-Za-z0-9._/-]*$/.test(repoPath) || repoPath.includes('..'))) return res.status(400).json({ error: 'invalid repoPath' });
  if (!config.github.pat) return res.status(422).json({ error: 'GitHub PAT not configured (ASTRODOCK_GITHUB_PAT)' });
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    await connectRepoInternal(app, githubRepo, branch, repoPath);
    res.json({ message: `Connected to ${githubRepo}`, app: serializeApp(await getAppBySlug(app.slug)) });
  } catch (err) {
    res.status(500).json({ error: `Failed to set up webhook: ${err.message}` });
  }
});

router.post('/:slug/disconnect-repo', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  if (app.githubRepo && app.webhookId) { try { await deleteWebhook(app.githubRepo, app.webhookId); } catch { /* best effort */ } }
  await db.update(schema.apps).set({ githubRepo: '', webhookId: null, webhookSecret: '', updatedAt: new Date() }).where(eq(schema.apps.id, app.id));
  res.json({ message: 'Repository disconnected', app: serializeApp(await getAppBySlug(app.slug)) });
});

// The names an app cannot take, with the reason for each. Read by the create-app
// form so the constraint is visible before it is hit.
router.get('/meta/reserved-subdomains', (req, res) => {
  res.json({ reserved: [...RESERVED_SUBDOMAINS].map(([name, reason]) => ({ name, reason })) });
});

// ── deploys ───────────────────────────────────────────────────────────────────
router.post('/:slug/deploy', requirePermission('deploys:write'), deployLimiter, async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const r = await runner.deploy(app.slug, { trigger: req.auth?.type === 'token' ? 'cli' : 'manual' }).catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  if (r.status === 200) return res.json({ message: 'Deploy triggered', deploymentId: r.body.deploymentId });
  res.status(r.status).json(r.body);
});

// Roll back to the last good build: redeploy the most recent successful commit
// (the one before what's currently live, if live is healthy).
router.post('/:slug/rollback', requirePermission('deploys:write'), deployLimiter, async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  if (!app.githubRepo) return res.status(400).json({ error: 'Rollback requires a connected GitHub repo' });
  const deps = await db.select({ status: schema.deployments.status, commitHash: schema.deployments.commitHash })
    .from(schema.deployments).where(eq(schema.deployments.appSlug, app.slug))
    .orderBy(desc(schema.deployments.createdAt)).limit(30);
  const successes = deps.filter((d) => d.status === 'success' && d.commitHash && d.commitHash !== 'local');
  if (!successes.length) return res.status(400).json({ error: 'No previous successful build to roll back to' });
  const liveCommit = deps[0] && deps[0].status === 'success' ? deps[0].commitHash : null;

  // A caller may name the build. "The last successful one" is the right default
  // and the wrong only option: a deploy can succeed and still be wrong — code
  // that builds, starts and passes a health check while doing the incorrect
  // thing — and then the most recent success is exactly what you want to skip.
  const wanted = (req.body || {}).commitHash;
  let target;
  if (wanted) {
    target = successes.find((d) => d.commitHash === wanted);
    if (!target) {
      return res.status(400).json({
        error: 'That build is not in this app\'s recent successful deploys, so there is nothing to redeploy.'
      });
    }
  } else {
    target = successes.find((d) => d.commitHash !== liveCommit) || successes[0];
  }
  const r = await runner.deploy(app.slug, { trigger: 'rollback', targetCommit: target.commitHash, commitHash: target.commitHash, commitMessage: `Rollback to ${target.commitHash}` })
    .catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  if (r.status === 200) return res.json({ message: `Rolling back to ${target.commitHash}`, deploymentId: r.body.deploymentId, commitHash: target.commitHash });
  res.status(r.status).json(r.body);
});

// ── custom domains ───────────────────────────────────────────────────────────
router.get('/:slug/domains', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.customDomains).where(eq(schema.customDomains.appId, app.id)).orderBy(desc(schema.customDomains.createdAt));
  res.json({ domains: rows.map((d) => ({ ...d, records: domainsLib.dnsRecords(d) })), publicIp: config.publicIp || null });
});

router.post('/:slug/domains', requirePermission('domains:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const hostname = domainsLib.normalizeHostname(req.body?.hostname);
  if (!domainsLib.validHostname(hostname)) return res.status(400).json({ error: 'Invalid hostname' });
  if (hostname === config.baseDomain || hostname.endsWith(`.${config.baseDomain}`)) {
    return res.status(400).json({ error: 'Names under the base domain use the subdomain field, not a custom domain' });
  }
  try {
    const [row] = await db.insert(schema.customDomains).values({ appId: app.id, hostname, verificationToken: domainsLib.genToken() }).returning();
    emitEvent({ category: 'audit', type: 'domain.added', severity: 'info', ...actorFromAuth(req.auth), ip: req.ip, appSlug: app.slug, targetType: 'app', targetId: app.slug, message: `Custom domain ${hostname} added` }).catch(() => {});
    res.status(201).json({ domain: { ...row, records: domainsLib.dnsRecords(row) } });
  } catch (err) {
    if (String(err.message).includes('custom_domains_hostname_uniq')) return res.status(409).json({ error: 'That hostname is already registered' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/:slug/domains/:id/verify', requirePermission('domains:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.customDomains).where(and(eq(schema.customDomains.id, req.params.id), eq(schema.customDomains.appId, app.id))).limit(1);
  const domain = rows[0];
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  const ok = await domainsLib.verifyOwnership(domain);
  const [updated] = await db.update(schema.customDomains).set({ status: ok ? 'active' : 'failed', lastCheckedAt: new Date(), updatedAt: new Date() }).where(eq(schema.customDomains.id, domain.id)).returning();
  if (ok) {
    await reloadCaddyFromDb().catch(() => {});
    emitEvent({ category: 'audit', type: 'domain.verified', severity: 'info', ...actorFromAuth(req.auth), ip: req.ip, appSlug: app.slug, message: `Custom domain ${domain.hostname} verified + activated` }).catch(() => {});
  }
  res.json({ domain: { ...updated, records: domainsLib.dnsRecords(updated) }, verified: ok, error: ok ? undefined : 'Verification TXT not found yet — DNS can take a few minutes to propagate.' });
});

router.patch('/:slug/domains/:id', requirePermission('domains:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.customDomains).where(and(eq(schema.customDomains.id, req.params.id), eq(schema.customDomains.appId, app.id))).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'Domain not found' });
  const set = { updatedAt: new Date() };
  if (req.body?.redirectToCanonical !== undefined) set.redirectToCanonical = !!req.body.redirectToCanonical;
  if (req.body?.isPrimary === true) {
    await db.update(schema.customDomains).set({ isPrimary: false }).where(eq(schema.customDomains.appId, app.id));
    set.isPrimary = true;
  } else if (req.body?.isPrimary === false) {
    set.isPrimary = false;
  }
  const [updated] = await db.update(schema.customDomains).set(set).where(eq(schema.customDomains.id, req.params.id)).returning();
  res.json({ domain: { ...updated, records: domainsLib.dnsRecords(updated) } });
});

router.delete('/:slug/domains/:id', requirePermission('domains:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.customDomains).where(and(eq(schema.customDomains.id, req.params.id), eq(schema.customDomains.appId, app.id))).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'Domain not found' });
  await db.delete(schema.customDomains).where(eq(schema.customDomains.id, req.params.id));
  await reloadCaddyFromDb().catch(() => {});
  emitEvent({ category: 'audit', type: 'domain.removed', severity: 'info', ...actorFromAuth(req.auth), ip: req.ip, appSlug: app.slug, message: `Custom domain ${rows[0].hostname} removed` }).catch(() => {});
  res.status(204).end();
});

// Local (non-GitHub) deploy: receive a gzipped tarball of the working dir and
// deploy it directly. Body is raw octet-stream (express.json skips non-JSON).
router.post('/:slug/deploy-local', requirePermission('deploys:write'), deployLimiter, express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload (send a gzipped tarball)' });
  // forward the tarball to the runner (which holds the build volumes + does the work)
  const r = await runner.deployLocal(app.slug, req.body).catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  if (r.status === 200) return res.json({ message: 'Local deploy triggered', deploymentId: r.body.deploymentId });
  res.status(r.status).json(r.body);
});

router.get('/:slug/deployments', async (req, res) => {
  const rows = await db.select({
    id: schema.deployments.id, appSlug: schema.deployments.appSlug, status: schema.deployments.status,
    trigger: schema.deployments.trigger, commitHash: schema.deployments.commitHash,
    commitMessage: schema.deployments.commitMessage, error: schema.deployments.error,
    startedAt: schema.deployments.startedAt, finishedAt: schema.deployments.finishedAt, createdAt: schema.deployments.createdAt
  }).from(schema.deployments).where(eq(schema.deployments.appSlug, req.params.slug)).orderBy(desc(schema.deployments.createdAt)).limit(20);
  res.json({ deployments: rows });
});

router.get('/:slug/deployments/:id', async (req, res) => {
  const rows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, req.params.id)).limit(1);
  const d = rows[0];
  if (!d || d.appSlug !== req.params.slug) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment: d });
});

// ── env vars ──────────────────────────────────────────────────────────────────
router.get('/:slug/env', requirePermission('env:read'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const envVars = await getAppEnvVars(app.id);
  res.json({ envVars: envVars.map(serializeEnvVar), missingRequired: computeMissingRequired(app, envVars) });
});

// Set a value (works for declared + reserved rows; creates an ad-hoc declared row if new).
router.put('/:slug/env/:key', requirePermission('env:write'), async (req, res) => {
  const { value, secret } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  if (/^ASTRODOCK_/.test(req.params.key)) {
    // only reserved rows the platform created (external mode) are settable
    const app = await getAppBySlug(req.params.slug);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
    if (!rows[0]) return res.status(400).json({ error: 'Reserved ASTRODOCK_* variables cannot be declared by apps' });
    const stored = rows[0].isSecret ? encryptSecret(value) : value;
    await db.update(schema.appEnvVars).set({ value: stored, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, rows[0].id));
    return res.json({ ok: true });
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(req.params.key)) return res.status(400).json({ error: 'key must be UPPER_SNAKE_CASE' });

  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
  if (rows[0]) {
    const stored = rows[0].isSecret ? encryptSecret(value) : value;
    await db.update(schema.appEnvVars).set({ value: stored, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, rows[0].id));
  } else {
    // Whether this is a secret is the caller's to say, and it used to be decided
    // here: every undeclared key was stored encrypted and masked forever. That is
    // right for `astrodock set-secret`, which says so in its name, and wrong for
    // the majority of variables — a log level, a feature flag, an upstream URL —
    // which an operator then could not read back. Anything added without saying
    // is treated as ordinary and stays readable.
    const isSecret = secret === true;
    await db.insert(schema.appEnvVars).values({
      appId: app.id, key: req.params.key,
      value: isSecret ? encryptSecret(value) : value,
      isSecret, kind: 'declared'
    });
  }
  res.json({ ok: true });
});

// Read one secret back, on purpose.
//
// Secrets are masked so they cannot be shoulder-surfed off a settings page or
// scraped by anything that can merely read. But an operator does sometimes need
// the actual value — to check it against the provider that issued it, most often
// — and "you can never see what you set" makes people store a second copy
// somewhere worse. So: deliberate, one at a time, step-up re-auth, and recorded.
router.post('/:slug/env/:key/reveal', requirePermission('env:read'), requireRecentAuth, async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.appEnvVars)
    .where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'No such variable' });

  emitEvent({
    category: 'audit', type: 'env.revealed', severity: 'warning',
    ...actorFromAuth(req.auth), ip: req.ip, appSlug: app.slug,
    targetType: 'env', targetId: req.params.key,
    message: `revealed the value of ${req.params.key} on ${app.slug}`
  }).catch(() => {});

  res.json({ key: req.params.key, value: decryptSecret(rows[0].value) });
});

router.post('/:slug/env/bulk', requirePermission('env:write'), async (req, res) => {
  const { raw } = req.body || {};
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'raw string is required' });
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const existing = await getAppEnvVars(app.id);
  const byKey = new Map(existing.map((r) => [r.key, r]));
  let added = 0; let skipped = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (!key || /^ASTRODOCK_/.test(key) || !/^[A-Z][A-Z0-9_]*$/.test(key)) { skipped++; continue; }
    const existingRow = byKey.get(key);
    if (existingRow) {
      // honor the declared isSecret flag — never store a declared secret in plaintext
      const stored = existingRow.isSecret ? encryptSecret(value) : value;
      await db.update(schema.appEnvVars).set({ value: stored, updatedAt: new Date() }).where(eq(schema.appEnvVars.id, existingRow.id));
    } else {
      await db.insert(schema.appEnvVars).values({ appId: app.id, key, value, kind: 'declared' });
    }
    added++;
  }
  res.json({ added, skipped });
});

router.delete('/:slug/env/:key', requirePermission('env:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const rows = await db.select().from(schema.appEnvVars).where(and(eq(schema.appEnvVars.appId, app.id), eq(schema.appEnvVars.key, req.params.key))).limit(1);
  if (!rows[0]) return res.status(404).json({ error: 'Env var not found' });
  if (rows[0].kind === 'reserved') return res.status(400).json({ error: 'Cannot delete a platform-required variable; change the resource mode instead' });
  await db.delete(schema.appEnvVars).where(eq(schema.appEnvVars.id, rows[0].id));
  res.status(204).end();
});

// ── process control ──────────────────────────────────────────────────────────────
router.get('/:slug/status', async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const r = await runner.status(app.slug).catch(() => ({ status: 503, body: { status: 'unavailable' } }));
  res.json(r.body || { status: 'unavailable' });
});

router.post('/:slug/restart', requirePermission('runtime:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const r = await runner.restart(app.slug).catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  res.status(r.status).json(r.status === 200 ? { message: 'Process restarted' } : r.body);
});

router.post('/:slug/stop', requirePermission('runtime:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const r = await runner.stop(app.slug).catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  res.status(r.status).json(r.status === 200 ? { message: 'Process stopped' } : r.body);
});

router.get('/:slug/logs', requirePermission('logs:read'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const r = await runner.logs(app.slug, parseInt(req.query.lines, 10) || 100).catch(() => ({ status: 503, body: { logs: '(runner unreachable)' } }));
  res.json(r.body || { logs: '' });
});

// HTTP access logs for the deployed app (opt-in: Settings → Caddy access logs).
// Reads Caddy's per-app JSON log from the shared volume. Best-effort.
router.get('/:slug/access-logs', requirePermission('logs:read'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const fs = require('fs');
  const file = path.join(config.paths.accessLogs, `${app.slug}.log`);
  let entries = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500);
    entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ enabled: false, recent: [], statusCounts: {}, note: 'No access log yet — enable "Caddy access logs for deployed apps" in Settings, then redeploy.' });
    return res.status(500).json({ error: err.message });
  }
  const statusCounts = {};
  for (const e of entries) { const s = String(e.status || '?'); statusCounts[s] = (statusCounts[s] || 0) + 1; }
  const recent = entries.slice(-100).reverse().map((e) => ({
    ts: e.ts, status: e.status, method: e.request && e.request.method, uri: e.request && e.request.uri,
    ip: e.request && (e.request.client_ip || e.request.remote_ip), duration: e.duration
  }));
  res.json({ enabled: true, count: entries.length, statusCounts, recent });
});

// ── hosted-login callbacks ───────────────────────────────────────────────────
// Where the platform may send a user back after signing in. Matched EXACTLY, so
// every callback an app uses has to be registered — including local development.
router.get('/:slug/redirect-uris', requirePermission('apps:read'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json({ uris: await oauth.listRedirectUris(app.id) });
});

router.post('/:slug/redirect-uris', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  try {
    const row = await oauth.addRedirectUri(app.id, (req.body || {}).uri);
    await emitEvent({
      category: 'audit', type: 'app.redirect_uri_added', severity: 'info',
      message: `Sign-in callback ${row.uri} allowed for ${app.slug}`,
      ...actorFromAuth(req.auth), targetType: 'app', targetId: app.slug, appSlug: app.slug, ip: req.ip || ''
    }).catch(() => {});
    res.status(201).json({ uri: row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:slug/redirect-uris/:id', requirePermission('apps:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  await oauth.removeRedirectUri(app.id, req.params.id);
  res.json({ ok: true });
});

// ── structured operations ────────────────────────────────────────────────────
// Reading files and inspecting state need logs:read — they disclose, they do not
// change. Running a declared command needs runtime:write, because it does.
router.get('/:slug/ops/list', requirePermission('logs:read'), async (req, res) => {
  const { status, body } = await runner.opsList(req.params.slug, req.query.path);
  res.status(status).json(body);
});
router.get('/:slug/ops/file', requirePermission('logs:read'), async (req, res) => {
  const { status, body } = await runner.opsFile(req.params.slug, req.query.path);
  res.status(status).json(body);
});
router.get('/:slug/ops/env', requirePermission('env:read'), async (req, res) => {
  const { status, body } = await runner.opsEnv(req.params.slug);
  res.status(status).json(body);
});
router.get('/:slug/ops/commands', requirePermission('logs:read'), async (req, res) => {
  const { status, body } = await runner.opsCommands(req.params.slug);
  res.status(status).json(body);
});
router.post('/:slug/ops/run', requirePermission('runtime:write'), async (req, res) => {
  const app = await getAppBySlug(req.params.slug);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { status, body } = await runner.opsRun(req.params.slug, req.body?.name);
  // Recorded as an event: a shell command was unauditable, a named one is not.
  await emitEvent({
    category: 'audit', type: 'app.command_run', severity: 'info',
    message: `Ran declared command "${req.body?.name}" for ${app.slug} (exit ${body?.exitCode})`,
    ...actorFromAuth(req.auth), targetType: 'app', targetId: app.slug, appSlug: app.slug, ip: req.ip || ''
  }).catch(() => {});
  res.status(status).json(body);
});

// The terminal used to live here. It spawned `sh -c` in the API container, which
// holds the key that decrypts every app's secret, the admin JWT signing secret and
// the runner token — and it did not work anyway, because the app's files are on the
// runner, which this container does not mount. Removed rather than gated: shipping
// a flag that grants full platform compromise, to enable something broken, is not a
// trade worth making. Replaced by structured operations (runner/app-ops.js), which
// cover what it was used for without arbitrary execution. See AUTH_DESIGN.md.

// Attached to the router so the settings route can refuse a redirect that would
// shadow a platform host, without a second copy of the list going stale.
router.reservedReason = reservedReason;

module.exports = router;
