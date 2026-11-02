'use strict';

// Approvals: actions an access key asks for that reach beyond one app.
//
// The case this exists for: someone talks a person into installing their app,
// and text in that app's repository tells the person's agent what to do with
// whatever key it can find. A key scoped to one app can only damage that app.
// The ways out of that box are creating another app, giving an app access to
// people who already have accounts here, and putting an app on a domain. Each of
// those now stops and asks.
//
// The flow:
//   1. The key makes the request. It gets 403 `approval_required` with a link.
//   2. A person opens the link and approves with a passkey or authenticator code
//      (lib/strong-factor), every time. An agent driving the browser cannot.
//   3. The key repeats the identical request with `X-Astrodock-Approval: <id>`.
//      The approval is bound to that key and to a hash of that exact request,
//      and is spent by the first use.
//
// People acting through the dashboard are not asked. They are the approval.

const crypto = require('crypto');
const { and, eq, gt, desc, inArray } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { getSetting } = require('./settings');
const { emitEvent } = require('./events');

// Long enough to find your phone, short enough that a forgotten request does
// not sit there waiting for someone to approve it by mistake next week.
const TTL_MS = 60 * 60 * 1000;
const HEADER = 'x-astrodock-approval';

async function enabled() {
  return (await getSetting('security.agent_approvals', 'on')) !== 'off';
}

// Key order must not change the hash, or a client that rebuilds the same body
// would be told its approval is for a different request.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function requestHash(req) {
  const route = `${req.method} ${(req.baseUrl || '') + (req.path || '')}`;
  return crypto.createHash('sha256').update(`${route}\n${canonical(req.body || {})}`).digest('hex');
}

function approvalUrl(id) {
  if (!config.isConfigured()) return `/approve/${id}`;
  const scheme = config.tlsMode === 'off' ? 'http' : 'https';
  return `${scheme}://${config.adminSubdomain}.${config.baseDomain}/approve/${id}`;
}

function statusOf(row) {
  if (row.status === 'pending' && new Date(row.expiresAt) <= new Date()) return 'expired';
  if (row.status === 'approved' && new Date(row.expiresAt) <= new Date()) return 'expired';
  return row.status;
}

function serialize(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: statusOf(row),
    summary: row.summary,
    details: row.details || {},
    tokenId: row.tokenId,
    tokenName: row.tokenName,
    requiredScope: row.requiredScope,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    usedAt: row.usedAt,
    url: approvalUrl(row.id)
  };
}

function requiredBody(row, extra = {}) {
  return {
    error: `This needs a person's approval: ${row.summary}. Ask them to open ${approvalUrl(row.id)} and approve it, `
      + `then repeat this exact request with the header "X-Astrodock-Approval: ${row.id}".`,
    code: 'approval_required',
    approval: serialize(row),
    retryWith: { header: 'X-Astrodock-Approval', value: row.id },
    ...extra
  };
}

/**
 * Decide whether a key's request may go ahead.
 * Returns { ok: true } or { status, body } to send instead.
 */
async function gate(req, { kind, scope, summary, details = {} }) {
  const auth = req.auth;
  if (!auth || auth.type !== 'token') return { ok: true };
  if (!await enabled()) return { ok: true };

  const hash = requestHash(req);
  const given = String(req.get(HEADER) || '').trim();

  if (given) {
    if (!/^[0-9a-f-]{36}$/i.test(given)) {
      return { status: 400, body: { error: 'X-Astrodock-Approval is not an approval id.', code: 'approval_invalid' } };
    }
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, given)).limit(1);
    if (!row || row.tokenId !== auth.id) {
      return { status: 403, body: { error: 'That approval was not issued to this key.', code: 'approval_invalid' } };
    }
    if (row.requestHash !== hash) {
      return {
        status: 403,
        body: { error: 'That approval was for a different request. Repeat the request exactly as it was first sent.', code: 'approval_mismatch' }
      };
    }
    const state = statusOf(row);
    if (state === 'pending') return { status: 403, body: requiredBody(row, { error: `Not approved yet. Waiting on ${approvalUrl(row.id)}.` }) };
    if (state !== 'approved') {
      return { status: 403, body: { error: `That approval is ${state}.`, code: `approval_${state}`, approval: serialize(row) } };
    }
    // Spent here, conditionally, so two requests racing on one approval cannot
    // both get through.
    const spent = await db.update(schema.approvals).set({ status: 'used', usedAt: new Date() })
      .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.status, 'approved')))
      .returning({ id: schema.approvals.id });
    if (!spent.length) return { status: 403, body: { error: 'That approval has already been used.', code: 'approval_used' } };
    return { ok: true, approval: row };
  }

  // The same key asking the same thing again gets the same approval back, so an
  // agent retrying in a loop does not fill the dashboard with copies.
  const [existing] = await db.select().from(schema.approvals)
    .where(and(
      eq(schema.approvals.tokenId, auth.id),
      eq(schema.approvals.requestHash, hash),
      inArray(schema.approvals.status, ['pending', 'approved']),
      gt(schema.approvals.expiresAt, new Date())
    ))
    .orderBy(desc(schema.approvals.createdAt)).limit(1);
  if (existing) return { status: 403, body: requiredBody(existing) };

  const [row] = await db.insert(schema.approvals).values({
    kind,
    tokenId: auth.id,
    tokenName: auth.name || '',
    requiredScope: scope,
    requestHash: hash,
    summary: String(summary).slice(0, 300),
    details,
    expiresAt: new Date(Date.now() + TTL_MS)
  }).returning();

  await emitEvent({
    category: 'audit', type: 'approval.requested', severity: 'warning',
    message: `Access key "${auth.name}" asked for approval: ${row.summary}`,
    actorType: 'token', actor: auth.name || 'token', targetType: 'approval', targetId: row.id, ip: req.ip || '',
    meta: { kind, details }
  }).catch(() => {});

  return { status: 403, body: requiredBody(row) };
}

/**
 * Route guard. `describe(req)` returns { summary, details } when this request
 * needs approval, or null when it does not (for example, applying a manifest to
 * an app that already exists). Runs after the permission check, so req.auth is set.
 */
function requireApproval({ kind, scope, describe }) {
  return async (req, res, next) => {
    try {
      if (!req.auth || req.auth.type !== 'token') return next();
      const d = await describe(req);
      if (!d) return next();
      const verdict = await gate(req, { kind, scope, ...d });
      if (verdict.ok) {
        req.approval = verdict.approval || null;
        return next();
      }
      return res.status(verdict.status).json(verdict.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}

async function find(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).limit(1);
  return row || null;
}

/** Record a person's decision. The caller has already checked their factor. */
async function decide(row, { approve, user }) {
  const state = statusOf(row);
  if (state !== 'pending') {
    const err = new Error(`This request is ${state}, so it cannot be ${approve ? 'approved' : 'declined'}.`);
    err.status = 409;
    throw err;
  }
  const [updated] = await db.update(schema.approvals)
    .set({ status: approve ? 'approved' : 'denied', decidedByUserId: user.id, decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.status, 'pending')))
    .returning();
  if (!updated) {
    const err = new Error('Someone else decided this one first.');
    err.status = 409;
    throw err;
  }
  await emitEvent({
    category: 'audit', type: approve ? 'approval.approved' : 'approval.denied', severity: 'info',
    message: `${user.email} ${approve ? 'approved' : 'declined'}: ${row.summary} (key "${row.tokenName}")`,
    actorType: 'admin', actor: user.email, targetType: 'approval', targetId: row.id,
    meta: { kind: row.kind, details: row.details }
  }).catch(() => {});
  return updated;
}

module.exports = {
  enabled, gate, requireApproval, requestHash, canonical, approvalUrl, serialize, statusOf, find, decide,
  TTL_MS, HEADER
};
