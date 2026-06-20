'use strict';

// Notification routing: given an event, find the matching rules and deliver to
// their channels (email / webhook), logging every attempt for audit + dedup.
//
// Out of the box (no rules configured) an IMPLICIT DEFAULT applies: email the
// configured alert address for health + deploy events at warning+ severity. This
// preserves the original health-alert behavior and adds deploy-failure alerts
// without any setup. The moment an operator creates their first rule, the default
// is materialized as a real, editable row (createRule) so adding e.g. a webhook
// rule never silently drops the existing email alerts.

const { eq, and, gt } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { sendEmail } = require('./email');

const CHANNELS = ['email', 'webhook'];
const SEVERITIES = ['info', 'warning', 'critical'];
const CATEGORIES = ['health', 'deploy', 'pages', 'auth', 'audit', 'system'];
const FORMATS = ['json', 'slack', 'discord'];

const SEV_RANK = { info: 0, warning: 1, critical: 2 };
const sevRank = (s) => (SEV_RANK[s] != null ? SEV_RANK[s] : 0);

function implicitDefaultRule() {
  if (!config.email.alertTo) return null;
  return {
    id: null, name: 'Default email alerts', enabled: true, implicit: true,
    channel: 'email', target: { to: config.email.alertTo },
    categories: ['health', 'deploy'], minSeverity: 'warning', appScope: []
  };
}

function ruleMatches(rule, event) {
  if (!rule.enabled) return false;
  const cats = rule.categories || [];
  if (cats.length && !cats.includes(event.category)) return false;
  if (sevRank(event.severity) < sevRank(rule.minSeverity)) return false;
  const scope = rule.appScope || [];
  if (scope.length && !(event.appSlug && scope.includes(event.appSlug))) return false;
  return true;
}

async function allRules() {
  const rows = await db.select().from(schema.notificationRules);
  return rows;
}

// Rules to apply for an event: stored rules if any exist, else the implicit default.
async function rulesFor(event) {
  let rules;
  try { rules = await allRules(); }
  catch (err) { console.error('[notifications] load rules failed:', err.message); return []; }
  if (!rules.length) { const d = implicitDefaultRule(); rules = d ? [d] : []; }
  return rules.filter((r) => ruleMatches(r, event));
}

// ── rendering ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function renderEmail(event) {
  const sevColor = { critical: '#dc2626', warning: '#d97706', info: '#0d9668' }[event.severity] || '#334155';
  const metaBlock = event.meta && Object.keys(event.meta).length
    ? `<pre style="background:#f1f5f9;padding:8px;border-radius:6px;font-size:12px">${escapeHtml(JSON.stringify(event.meta, null, 2))}</pre>` : '';
  return {
    subject: `[Astrodock] ${event.severity.toUpperCase()} — ${event.message || event.type}`,
    html: `<h2 style="color:${sevColor}">${escapeHtml(event.message || event.type)}</h2>`
      + `<p style="color:#475569">Category: ${event.category} · Type: ${event.type}`
      + (event.appSlug ? ` · App: ${escapeHtml(event.appSlug)}` : '')
      + (event.actor && event.actor !== 'system' ? ` · By: ${escapeHtml(event.actor)}` : '') + `</p>`
      + metaBlock + `<hr><p style="color:#888;font-size:12px">Astrodock</p>`
  };
}
function webhookBody(event, format) {
  const summary = `[Astrodock] ${event.severity.toUpperCase()} — ${event.message || event.type}`
    + (event.appSlug ? ` (${event.appSlug})` : '');
  if (format === 'slack') return { text: summary };
  if (format === 'discord') return { content: summary };
  return {
    event: {
      category: event.category, type: event.type, severity: event.severity,
      message: event.message || '', appSlug: event.appSlug || null,
      actor: event.actor || 'system', targetType: event.targetType || null,
      targetId: event.targetId || null, meta: event.meta || {}
    }
  };
}

// ── channel adapters: each returns { status, target, error? } and never throws ──
async function dispatchEmail(rule, event) {
  const to = (rule.target && rule.target.to) || config.email.alertTo;
  if (!to) return { status: 'skipped', target: '', error: 'no recipient configured' };
  const content = (event.email && event.email.subject) ? event.email : renderEmail(event);
  try { await sendEmail({ to, subject: content.subject, html: content.html }); return { status: 'sent', target: to }; }
  catch (err) { return { status: 'failed', target: to, error: err.message }; }
}
async function dispatchWebhook(rule, event) {
  const url = rule.target && rule.target.url;
  if (!url) return { status: 'skipped', target: '', error: 'no url configured' };
  const format = (rule.target && rule.target.format) || 'json';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookBody(event, format)),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });
    if (!res.ok) return { status: 'failed', target: url, error: `HTTP ${res.status}` };
    return { status: 'sent', target: url };
  } catch (err) { return { status: 'failed', target: url, error: err.message }; }
}
function dispatch(rule, event) {
  return rule.channel === 'webhook' ? dispatchWebhook(rule, event) : dispatchEmail(rule, event);
}

// ── delivery log + dedup ──
async function recordDelivery(row) {
  try { await db.insert(schema.notificationDeliveries).values(row); }
  catch (err) { console.error('[notifications] delivery log failed:', err.message); }
}
async function recentlySent(dedupeKey, channel, windowMs) {
  if (!dedupeKey || !windowMs) return false;
  try {
    const since = new Date(Date.now() - windowMs);
    const rows = await db.select({ id: schema.notificationDeliveries.id })
      .from(schema.notificationDeliveries)
      .where(and(
        eq(schema.notificationDeliveries.dedupeKey, dedupeKey),
        eq(schema.notificationDeliveries.channel, channel),
        eq(schema.notificationDeliveries.status, 'sent'),
        gt(schema.notificationDeliveries.createdAt, since)
      )).limit(1);
    return !!rows[0];
  } catch { return false; }
}

// Route an event to all matching rules. Awaitable through delivery so short-lived
// callers (the deploy worker) don't exit before sends complete.
async function route(event) {
  const rules = await rulesFor(event);
  const dedupeKey = event.dedupeKey || '';
  const dedupeWindowMs = event.dedupeWindowMs || 0;
  await Promise.all(rules.map(async (rule) => {
    if (await recentlySent(dedupeKey, rule.channel, dedupeWindowMs)) {
      await recordDelivery({ eventId: event.id || null, ruleId: rule.id || null, channel: rule.channel, target: '', status: 'suppressed', dedupeKey });
      return;
    }
    const result = await dispatch(rule, event);
    await recordDelivery({ eventId: event.id || null, ruleId: rule.id || null, channel: rule.channel, target: result.target || '', status: result.status, error: result.error || '', dedupeKey });
  }));
}

// ── rule validation + CRUD ──
function normalizeRule(b, current) {
  const out = {};
  const channel = b.channel !== undefined ? b.channel : current && current.channel;
  if (!CHANNELS.includes(channel)) throw badReq(`channel must be one of: ${CHANNELS.join(', ')}`);
  out.channel = channel;

  const target = b.target !== undefined ? b.target : (current ? current.target : {});
  if (!target || typeof target !== 'object') throw badReq('target must be an object');
  if (channel === 'email') {
    if (!target.to || typeof target.to !== 'string') throw badReq('email rule needs target.to');
    out.target = { to: target.to.trim() };
  } else {
    if (!target.url || !/^https?:\/\//i.test(target.url)) throw badReq('webhook rule needs an http(s) target.url');
    const format = target.format || 'json';
    if (!FORMATS.includes(format)) throw badReq(`webhook format must be one of: ${FORMATS.join(', ')}`);
    out.target = { url: target.url.trim(), format };
  }

  if (b.name !== undefined) out.name = String(b.name).slice(0, 120);
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.minSeverity !== undefined) {
    if (!SEVERITIES.includes(b.minSeverity)) throw badReq(`minSeverity must be one of: ${SEVERITIES.join(', ')}`);
    out.minSeverity = b.minSeverity;
  }
  if (b.categories !== undefined) {
    if (!Array.isArray(b.categories)) throw badReq('categories must be an array');
    const bad = b.categories.filter((c) => !CATEGORIES.includes(c));
    if (bad.length) throw badReq(`unknown categories: ${bad.join(', ')}`);
    out.categories = b.categories;
  }
  if (b.appScope !== undefined) {
    if (!Array.isArray(b.appScope)) throw badReq('appScope must be an array of slugs');
    out.appScope = b.appScope.map((s) => String(s));
  }
  return out;
}
function badReq(msg) { const e = new Error(msg); e.status = 400; return e; }

function rowOf(rule) {
  return {
    name: rule.name || '', enabled: rule.enabled !== false, channel: rule.channel,
    target: rule.target || {}, categories: rule.categories || [],
    minSeverity: rule.minSeverity || 'info', appScope: rule.appScope || []
  };
}

async function listRules() {
  const rows = await allRules();
  if (!rows.length) {
    const d = implicitDefaultRule();
    return d ? [d] : [];
  }
  return rows;
}

async function createRule(body) {
  const fields = normalizeRule(body, null);
  // Materialize the implicit default as a real row before the first custom rule,
  // so it isn't silently lost once the table is non-empty.
  const existing = await db.select({ id: schema.notificationRules.id }).from(schema.notificationRules).limit(1);
  if (!existing.length) {
    const d = implicitDefaultRule();
    if (d) await db.insert(schema.notificationRules).values(rowOf(d));
  }
  const [row] = await db.insert(schema.notificationRules).values({ ...rowOf({ minSeverity: 'info', categories: [], appScope: [], ...fields }) }).returning();
  return row;
}

async function updateRule(id, body) {
  const rows = await db.select().from(schema.notificationRules).where(eq(schema.notificationRules.id, id)).limit(1);
  if (!rows[0]) return null;
  const fields = normalizeRule(body, rows[0]);
  const [row] = await db.update(schema.notificationRules)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(schema.notificationRules.id, id)).returning();
  return row;
}

async function deleteRule(id) {
  const res = await db.delete(schema.notificationRules).where(eq(schema.notificationRules.id, id)).returning({ id: schema.notificationRules.id });
  return !!res[0];
}

// Send a one-off test notification to an ad-hoc channel/target (no rule needed).
async function sendTest(body) {
  const fields = normalizeRule(body, null); // validates channel + target
  const event = { category: 'system', type: 'test.alert', severity: 'info', actor: 'system',
    message: 'Test alert from Astrodock — your notification channel is working.', meta: { test: true } };
  const result = await dispatch({ channel: fields.channel, target: fields.target }, event);
  await recordDelivery({ eventId: null, ruleId: null, channel: fields.channel, target: result.target || '', status: result.status, error: result.error || '', dedupeKey: '' });
  return result;
}

module.exports = {
  route, listRules, createRule, updateRule, deleteRule, sendTest,
  // exported for tests / reuse
  ruleMatches, implicitDefaultRule, CHANNELS, SEVERITIES, CATEGORIES, FORMATS
};
