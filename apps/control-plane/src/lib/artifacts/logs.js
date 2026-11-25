'use strict';

// Artifact logging. What is kept, and how:
//
//   views       every HTML page served, and every sign-in redirect      artifact_views
//   writes      every create, update, delete and blob write, in full     artifact_api_log
//   failures    every data call that failed (except a plain 401)         artifact_api_log + artifact_errors
//   reads       counted per artifact, person, target and hour            artifact_read_counts
//   sign-ins    every attempt and its outcome                            artifact_signins
//   errors      from the page (client.js) and the server, grouped         artifact_errors
//   history     before and after of every record and blob change         artifact_revisions
//   reports     "Report a Problem" from the footer                       artifact_reports
//
// Everything but reports is deleted after logging.artifact_log_retention_days.
// IP addresses follow logging.page_view_ip (full, truncated, off).
//
// Logging never breaks the request it describes: every write is best-effort.

const crypto = require('crypto');
const { and, eq, lt, sql } = require('drizzle-orm');
const { db, schema } = require('../../db');
const { getSetting } = require('../settings');

const DAY = 864e5;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const quiet = (p) => p.catch((err) => console.error('[artifact-logs]', err.message));

function truncateIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
  const parts = ip.split('.');
  if (parts.length === 4) { parts[3] = '0'; return parts.join('.'); }
  return ip;
}

async function ipOf(req) {
  const mode = await getSetting('logging.page_view_ip', 'full');
  const ip = (req && req.ip) || '';
  if (mode === 'off') return '';
  return mode === 'truncated' ? truncateIp(ip) : ip;
}

const who = (viewer) => ({ userId: (viewer && viewer.userId) || null, email: (viewer && viewer.email) || '' });

function view(artifact, req, viewer, path, status) {
  return quiet((async () => {
    await db.insert(schema.artifactViews).values({
      artifactId: artifact.id, ...who(viewer), path: clip(path, 500), status,
      ip: await ipOf(req), userAgent: clip(req.get('user-agent'), 300), referrer: clip(req.get('referer'), 400)
    });
  })());
}

function api(artifact, req, viewer, { op, target = '', recordId = '', status, durationMs = 0, error = '' }) {
  return quiet((async () => {
    await db.insert(schema.artifactApiLog).values({
      artifactId: artifact.id, ...who(viewer), method: req.method, op, target: clip(target, 100),
      recordId: clip(recordId, 64), status, durationMs: Math.round(durationMs), error: clip(error, 1000), ip: await ipOf(req)
    });
  })());
}

// ── reads: counted in memory, written once a minute ────────────────────────
const pending = new Map();
function countRead(artifact, viewer, target) {
  const hour = new Date(Math.floor(Date.now() / 3600e3) * 3600e3).toISOString();
  const key = JSON.stringify([artifact.id, hour, (viewer && viewer.userId) || '', clip(target, 100)]);
  pending.set(key, (pending.get(key) || 0) + 1);
}

async function flushReads() {
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [key, n] of batch) {
    const [artifactId, hour, userKey, target] = JSON.parse(key);
    await db.insert(schema.artifactReadCounts).values({ artifactId, hour: new Date(hour), userKey, target, count: n })
      .onConflictDoUpdate({
        target: [schema.artifactReadCounts.artifactId, schema.artifactReadCounts.hour, schema.artifactReadCounts.userKey, schema.artifactReadCounts.target],
        set: { count: sql`${schema.artifactReadCounts.count} + ${n}` }
      }).catch((err) => {
        // An artifact deleted since the read was counted; nothing to keep.
        if (!/foreign key/i.test(err.message)) console.error('[artifact-logs] read flush:', err.message);
      });
  }
}
let flushTimer = null;
function startFlushing() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushReads().catch(() => {}); }, 60000);
  flushTimer.unref();
}

function signin(artifact, req, email, result) {
  return quiet((async () => {
    await db.insert(schema.artifactSignins).values({
      artifactId: artifact.id, email: clip(String(email || '').toLowerCase(), 254), result,
      ip: await ipOf(req), userAgent: clip(req.get('user-agent'), 300)
    });
  })());
}

// ── errors ─────────────────────────────────────────────────────────────────
const KINDS = new Set(['error', 'rejection', 'console', 'network', 'api', 'server']);
const MAX_DISTINCT = 500;          // distinct errors kept per artifact
const REPORTS_PER_HOUR = 600;      // page reports accepted per artifact per hour
const reportBudget = new Map();

function fingerprint(kind, message, source) {
  // Ids first: the number rule would otherwise break them up before they match.
  const norm = String(message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').replace(/\d{3,}/g, '#').slice(0, 300);
  return crypto.createHash('sha1').update(`${kind}\n${norm}\n${source}`).digest('hex');
}

/** Spend one unit of an artifact's hourly budget for page reports. False when spent. */
function takeReportBudget(artifactId) {
  const hour = Math.floor(Date.now() / 3600e3);
  const b = reportBudget.get(artifactId);
  if (!b || b.hour !== hour) { reportBudget.set(artifactId, { hour, n: 1 }); return true; }
  if (b.n >= REPORTS_PER_HOUR) return false;
  b.n++;
  return true;
}

function error(artifact, { kind, message, source = '', stack = '', path = '', userAgent = '', email = '' }) {
  if (!KINDS.has(kind)) return Promise.resolve();
  const msg = clip(message, 1000);
  const src = clip(source, 300);
  const fp = fingerprint(kind, msg, src);
  const mail = clip(String(email || '').toLowerCase(), 254);
  return quiet((async () => {
    const E = schema.artifactErrors;
    const updated = await db.update(E).set({
      count: sql`${E.count} + 1`,
      lastSeen: new Date(),
      stack: clip(stack, 4000) || sql`${E.stack}`,
      path: clip(path, 500) || sql`${E.path}`,
      userAgent: clip(userAgent, 300) || sql`${E.userAgent}`,
      emails: mail
        ? sql`CASE WHEN ${E.emails} ? ${mail} OR jsonb_array_length(${E.emails}) >= 100 THEN ${E.emails} ELSE ${E.emails} || to_jsonb(${mail}::text) END`
        : sql`${E.emails}`
    }).where(and(eq(E.artifactId, artifact.id), eq(E.fingerprint, fp))).returning({ id: E.id });
    if (updated[0]) return;
    const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(E).where(eq(E.artifactId, artifact.id));
    if (n >= MAX_DISTINCT) return;
    // Two reports of a new error can arrive together: the second one counts.
    await db.insert(E).values({
      artifactId: artifact.id, fingerprint: fp, kind, message: msg, source: src,
      stack: clip(stack, 4000), path: clip(path, 500), userAgent: clip(userAgent, 300), emails: mail ? [mail] : []
    }).onConflictDoUpdate({ target: [E.artifactId, E.fingerprint], set: { count: sql`${E.count} + 1`, lastSeen: new Date() } });
  })());
}

function revision(artifact, { kind = 'record', target, recordId = '', action, before = null, after = null, viewer }) {
  return quiet(db.insert(schema.artifactRevisions).values({
    artifactId: artifact.id, kind, target, recordId: String(recordId || ''), action, before, after,
    actorId: (viewer && viewer.userId) || null, actorEmail: (viewer && viewer.email) || ''
  }));
}

async function report(artifact, req, { kind, message, email }) {
  const [row] = await db.insert(schema.artifactReports).values({
    artifactId: artifact.id, kind, message: clip(message, 4000), email: clip(email, 254), ip: await ipOf(req)
  }).returning();
  return row;
}

async function prune(now = Date.now()) {
  const days = await getSetting('logging.artifact_log_retention_days', 90);
  const cutoff = new Date(now - days * DAY);
  await db.delete(schema.artifactViews).where(lt(schema.artifactViews.createdAt, cutoff));
  await db.delete(schema.artifactApiLog).where(lt(schema.artifactApiLog.createdAt, cutoff));
  await db.delete(schema.artifactReadCounts).where(lt(schema.artifactReadCounts.hour, cutoff));
  await db.delete(schema.artifactSignins).where(lt(schema.artifactSignins.createdAt, cutoff));
  await db.delete(schema.artifactErrors).where(lt(schema.artifactErrors.lastSeen, cutoff));
  await db.delete(schema.artifactRevisions).where(lt(schema.artifactRevisions.createdAt, cutoff));
  // Spent sign-in codes and grants are worthless after a day.
  await db.delete(schema.artifactCodes).where(lt(schema.artifactCodes.expiresAt, new Date(now - DAY)));
  await db.delete(schema.artifactGrants).where(lt(schema.artifactGrants.expiresAt, new Date(now - DAY)));
}

// ── usage ──────────────────────────────────────────────────────────────────

/**
 * Usage for artifacts, one row each. `ids` limits it to those artifacts (uuid
 * list); null means every artifact. Windows: views and people over 30 days,
 * errors over 7.
 */
async function usage(ids = null) {
  // ISO strings cast in SQL: raw queries do not take Date parameters.
  const d30 = sql`${new Date(Date.now() - 30 * DAY).toISOString()}::timestamptz`;
  const d7 = sql`${new Date(Date.now() - 7 * DAY).toISOString()}::timestamptz`;
  if (Array.isArray(ids) && !ids.length) return [];
  // One array parameter, cast in SQL, rather than a list spliced into the text.
  const scope = (col) => (ids ? sql`${col} = ANY(${`{${ids.join(',')}}`}::uuid[])` : sql`true`);
  const rows = await db.execute(sql`
    SELECT a.id,
      (SELECT count(*)::int FROM artifact_views v WHERE v.artifact_id = a.id AND v.created_at > ${d30} AND v.status < 300) AS views30,
      (SELECT count(DISTINCT u)::int FROM (
         SELECT user_id AS u FROM artifact_views WHERE artifact_id = a.id AND created_at > ${d30} AND user_id IS NOT NULL
         UNION SELECT user_id FROM artifact_api_log WHERE artifact_id = a.id AND created_at > ${d30} AND user_id IS NOT NULL) p) AS people30,
      (SELECT count(*)::int FROM artifact_api_log l WHERE l.artifact_id = a.id AND l.created_at > ${d30} AND l.method <> 'GET' AND l.status < 400) AS writes30,
      (SELECT coalesce(sum(count), 0)::int FROM artifact_read_counts r WHERE r.artifact_id = a.id AND r.hour > ${d30}) AS reads30,
      (SELECT count(*)::int FROM artifact_records r WHERE r.artifact_id = a.id) AS records,
      (SELECT coalesce(sum(size), 0)::bigint FROM artifact_records r WHERE r.artifact_id = a.id) AS record_bytes,
      (SELECT coalesce(sum(octet_length(data::text)), 0)::bigint FROM artifact_blobs b WHERE b.artifact_id = a.id) AS blob_bytes,
      (SELECT coalesce(sum(size), 0)::bigint FROM artifact_files f WHERE f.artifact_id = a.id) AS file_bytes,
      (SELECT coalesce(sum(size), 0)::bigint FROM artifact_uploads u WHERE u.artifact_id = a.id) AS upload_bytes,
      (SELECT coalesce(sum(bytes), 0)::bigint FROM artifact_egress e WHERE e.artifact_id = a.id AND e.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')) AS egress_month,
      (SELECT count(*)::int FROM artifact_shares s WHERE s.artifact_id = a.id) AS shares,
      (SELECT count(*)::int FROM artifact_sends s WHERE s.artifact_id = a.id AND s.created_at > ${d30} AND s.status = 'sent' AND s.kind IN ('invite', 'action', 'code')) AS emails30,
      (SELECT coalesce(sum(count), 0)::int FROM artifact_errors e WHERE e.artifact_id = a.id AND e.last_seen > ${d7}) AS errors7,
      (SELECT count(*)::int FROM artifact_reports r WHERE r.artifact_id = a.id AND r.status = 'open') AS open_reports,
      GREATEST(
        (SELECT max(created_at) FROM artifact_views WHERE artifact_id = a.id),
        (SELECT max(created_at) FROM artifact_api_log WHERE artifact_id = a.id)) AS last_activity
    FROM artifacts a WHERE ${scope(sql`a.id`)}`);
  return (rows.rows || rows).map((r) => ({
    id: r.id,
    views30: r.views30, people30: r.people30, writes30: r.writes30, reads30: r.reads30,
    records: r.records,
    storageBytes: Number(r.record_bytes) + Number(r.blob_bytes) + Number(r.file_bytes) + Number(r.upload_bytes),
    fileBytes: Number(r.file_bytes), dataBytes: Number(r.record_bytes) + Number(r.blob_bytes), uploadBytes: Number(r.upload_bytes),
    egressThisMonth: Number(r.egress_month),
    shares: r.shares, emails30: r.emails30, errors7: r.errors7, openReports: r.open_reports,
    lastActivity: r.last_activity
  }));
}

/** Per person on one artifact: role, last seen, views and writes over 30 days. */
async function people(artifact) {
  const d30 = sql`${new Date(Date.now() - 30 * DAY).toISOString()}::timestamptz`;
  const rows = await db.execute(sql`
    WITH members AS (
      SELECT email, role FROM artifact_shares WHERE artifact_id = ${artifact.id}
      UNION SELECT u.email, 'owner' FROM users u WHERE u.id = ${artifact.ownerId}
    ), seen AS (
      SELECT lower(email) AS email, max(created_at) AS last_seen,
        count(*) FILTER (WHERE kind = 'view' AND created_at > ${d30})::int AS views30,
        count(*) FILTER (WHERE kind = 'write' AND created_at > ${d30})::int AS writes30
      FROM (
        SELECT email, created_at, 'view' AS kind FROM artifact_views WHERE artifact_id = ${artifact.id} AND email <> ''
        UNION ALL SELECT email, created_at, CASE WHEN method = 'GET' THEN 'read' ELSE 'write' END FROM artifact_api_log
          WHERE artifact_id = ${artifact.id} AND email <> ''
      ) x GROUP BY lower(email)
    )
    SELECT coalesce(m.email, s.email) AS email, m.role, s.last_seen, coalesce(s.views30, 0) AS views30, coalesce(s.writes30, 0) AS writes30
    FROM members m FULL JOIN seen s ON s.email = lower(m.email)
    ORDER BY s.last_seen DESC NULLS LAST, 1`);
  return (rows.rows || rows).map((r) => ({ email: r.email, role: r.role || null, lastSeen: r.last_seen, views30: r.views30, writes30: r.writes30 }));
}

module.exports = {
  view, api, countRead, flushReads, startFlushing, signin, error, takeReportBudget, revision, report, prune,
  usage, people, truncateIp, fingerprint, _pending: pending
};
