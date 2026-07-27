'use strict';

// Access keys — the agent surface.
//
// Creatable by a person, and by a key that holds tokens:write. The delegation
// rules (lib/scopes.checkDelegation) make "a key can never mint something at its
// own level or above" structural rather than a policy: strictly fewer scopes, no
// wider app scope, no longer expiry, and tokens:write is never grantable BY a key,
// so chains stop at depth one.

const express = require('express');
const { eq, desc, isNull } = require('drizzle-orm');
const { db, schema } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { requireRecentAuth } = require('../lib/sessions');
const { generateApiToken, hashToken } = require('../lib/ids');
const { emitEvent, actorFromAuth } = require('../lib/events');
const scopes = require('../lib/scopes');

const router = express.Router();
router.use(requirePermission('tokens:write'));

const DEFAULT_TTL_DAYS = 90;

/** What can be handed out, and by whom — so the UI can render honest choices. */
router.get('/options', (req, res) => {
  const mine = req.auth.type === 'token' ? scopes.expand(req.auth.scopes) : scopes.ALL;
  res.json({
    scopes: Object.entries(scopes.SCOPES).map(([key, description]) => ({
      key,
      description,
      // A key cannot grant what it does not hold, so grey those out rather than
      // letting someone build a request that will be refused.
      grantable: req.auth.type !== 'token' ? key !== 'tokens:write' : (mine.includes(key) && key !== 'tokens:write')
    })),
    presets: Object.entries(scopes.PRESETS).map(([key, p]) => ({ key, ...p })),
    defaultExpiryDays: DEFAULT_TTL_DAYS,
    delegating: req.auth.type === 'token'
  });
});

router.get('/', async (req, res) => {
  const rows = await db.select({
    id: schema.apiTokens.id, name: schema.apiTokens.name, scopes: schema.apiTokens.scopes,
    appScope: schema.apiTokens.appScope, lastUsedAt: schema.apiTokens.lastUsedAt,
    expiresAt: schema.apiTokens.expiresAt, revokedAt: schema.apiTokens.revokedAt,
    authorizedByUserId: schema.apiTokens.authorizedByUserId,
    createdByTokenId: schema.apiTokens.createdByTokenId,
    createdAt: schema.apiTokens.createdAt
  }).from(schema.apiTokens).orderBy(desc(schema.apiTokens.createdAt));

  res.json({
    tokens: rows.map((t) => ({
      ...t,
      effectiveScopes: scopes.expand(t.scopes),
      // Surface legacy keys so an operator can see which predate the scope model.
      legacy: scopes.isLegacy(t.scopes),
      expired: !!(t.expiresAt && new Date(t.expiresAt) <= new Date()),
      delegated: !!t.createdByTokenId
    }))
  });
});

router.post('/', requireRecentAuth, async (req, res) => {
  const { name, scopes: requested, apps, preset, expiresInDays } = req.body || {};
  try {
    if (!name) return res.status(400).json({ error: 'Give the key a name so you can recognise it later.' });

    let wanted = Array.isArray(requested) && requested.length ? requested : null;
    if (!wanted && preset) {
      const p = scopes.PRESETS[preset];
      if (!p) return res.status(400).json({ error: `Unknown preset: ${preset}` });
      wanted = p.scopes;
    }
    if (!wanted) return res.status(400).json({ error: 'Choose a preset or a list of permissions.' });

    const expanded = scopes.validate(wanted);
    const appScope = Array.isArray(apps)
      ? apps.filter((s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s)) : [];

    // Keys expire by default. "Never" has to be asked for.
    const days = expiresInDays === null ? null : (Number(expiresInDays) || DEFAULT_TTL_DAYS);
    let expiresAt = days === null ? null : new Date(Date.now() + days * 86400 * 1000);

    // The delegation check is a no-op for a person and the whole point for a key.
    const minter = req.auth.type === 'token' ? req.auth : null;

    // Cap a delegated key at its parent's expiry rather than refusing. Without
    // this the DEFAULT is already a refusal: a child minted from a 90-day key gets
    // its own 90 days starting now, which outlives the parent by however long the
    // parent has been alive. Asking every caller to compute that is a trap.
    if (minter && minter.expiresAt) {
      const cap = new Date(minter.expiresAt);
      if (!expiresAt || expiresAt > cap) expiresAt = cap;
    }
    scopes.checkDelegation(minter, { scopes: expanded, appScope, expiresAt });

    const raw = generateApiToken();
    const [row] = await db.insert(schema.apiTokens).values({
      name,
      tokenHash: hashToken(raw),
      scopes: expanded,
      appScope,
      expiresAt,
      // The human at the root of the chain. A key minted by a key inherits it, so
      // every action can name who authorised it however deep the chain went.
      authorizedByUserId: minter ? minter.authorizedByUserId : req.auth.sub,
      createdByTokenId: minter ? minter.id : null
    }).returning();

    await emitEvent({
      category: 'audit', type: 'token.created', severity: 'info',
      message: `Access key "${name}" created with ${expanded.length} permission(s)`
        + (appScope.length ? ` for ${appScope.join(', ')}` : '')
        + (minter ? ` (delegated by key "${minter.name}")` : ''),
      ...actorFromAuth(req.auth), targetType: 'token', targetId: row.id, ip: req.ip || '',
      meta: { scopes: expanded, appScope, expiresAt }
    }).catch(() => {});

    res.status(201).json({
      token: raw, // shown ONCE
      id: row.id, name: row.name, scopes: expanded, appScope, expiresAt,
      note: 'Copy this now — it is not shown again.'
        + (appScope.length ? ` Limited to: ${appScope.join(', ')}.` : '')
        + (expiresAt ? ` Expires ${expiresAt.toISOString().slice(0, 10)}.` : ' Does not expire.')
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Revoke rather than delete, so the audit trail keeps pointing at something real.
router.delete('/:id', requireRecentAuth, async (req, res) => {
  const [row] = await db.select().from(schema.apiTokens)
    .where(eq(schema.apiTokens.id, req.params.id)).limit(1);
  if (!row) return res.status(404).json({ error: 'Key not found' });

  await db.update(schema.apiTokens).set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.id, req.params.id));

  // Revoking a key revokes everything it created: a delegated key outliving its
  // parent would be a way to keep access after the parent was taken away.
  const children = await db.update(schema.apiTokens).set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.createdByTokenId, req.params.id)).returning({ id: schema.apiTokens.id });

  await emitEvent({
    category: 'audit', type: 'token.revoked', severity: 'info',
    message: `Access key "${row.name}" revoked`
      + (children.length ? `, along with ${children.length} key(s) it created` : ''),
    ...actorFromAuth(req.auth), targetType: 'token', targetId: row.id, ip: req.ip || ''
  }).catch(() => {});

  res.json({ ok: true, revokedChildren: children.length });
});

module.exports = router;
