'use strict';

// Built-in actions that send mail: `email` on a change, and the daily `digest`.
// (`stamp` runs inside the write, in records.js.)
//
// Mail only ever goes to people who have access to the artifact: the owner, or
// someone on the share list. An email field naming a stranger sends nothing, so
// an artifact cannot be used to mail arbitrary addresses. Every send counts
// toward the owner's daily cap.

const { and, eq, gt, sql } = require('drizzle-orm');
const config = require('../../config');
const { db, schema } = require('../../db');
const { sendEmail } = require('../email');
const { esc } = require('../auth-pages');
const M = require('./manifest');
const access = require('./access');

const DAY_MS = 864e5;

async function sentToday(ownerId, kind) {
  const [r] = await db.select({ n: sql`count(*)::int` }).from(schema.artifactSends)
    .where(and(eq(schema.artifactSends.ownerId, ownerId), eq(schema.artifactSends.kind, kind),
      gt(schema.artifactSends.createdAt, new Date(Date.now() - DAY_MS))));
  return r ? r.n : 0;
}

async function logSend(artifact, kind, recipient, status) {
  await db.insert(schema.artifactSends).values({
    artifactId: artifact.id, ownerId: artifact.ownerId, kind, recipient, status
  }).catch(() => {});
}

/** Everyone with access, as { email, role }. The owner holds the top role. */
async function members(artifact, manifest) {
  const out = [];
  if (artifact.ownerId) {
    const [o] = await db.select({ email: schema.users.email, isActive: schema.users.isActive }).from(schema.users)
      .where(eq(schema.users.id, artifact.ownerId)).limit(1);
    if (o && o.isActive) out.push({ email: o.email, role: manifest.roles[0] });
  }
  const shares = await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, artifact.id));
  for (const s of shares) {
    if (!out.some((m) => m.email === s.email)) {
      out.push({ email: s.email, role: manifest.roles.includes(s.role) ? s.role : manifest.roles[manifest.roles.length - 1] });
    }
  }
  return out;
}

async function recipients(artifact, manifest, to, row) {
  const all = await members(artifact, manifest);
  if (to.role) {
    const ok = new Set(M.rolesAtOrAbove(manifest, to.role));
    return all.filter((m) => ok.has(m.role)).map((m) => m.email);
  }
  const want = to.author ? row.authorEmail : access.normEmail((row.data || {})[to.field]);
  if (!want) return [];
  return all.some((m) => m.email === want) ? [want] : [];
}

/** {{field}} from the record; anything else is left out. Plain text in, escaped. */
function fill(template, row) {
  const data = row.data || {};
  return String(template).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, k) => {
    if (k === '_author') return row.authorEmail || '';
    const v = data[k];
    if (v == null) return '';
    if (typeof v === 'object') return '';
    return String(v).slice(0, 500);
  });
}

function wrapper(artifact, heading, paragraphs, link) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px;color:#3f3f46;white-space:pre-wrap">${esc(p)}</p>`).join('');
  return `<div style="font:14px/1.5 -apple-system,'Segoe UI',sans-serif;max-width:520px">
<p style="margin:0 0 4px;color:#71717a;font-size:12px">${esc(artifact.title || 'Untitled')}</p>
<h2 style="margin:0 0 16px;font-size:18px;color:#09090b">${esc(heading)}</h2>
${body}
<p style="margin:16px 0"><a href="${esc(link)}" style="color:#0b7c56">Open ${esc(artifact.title || 'the artifact')}</a></p>
<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #ececee;color:#a1a1aa;font-size:12px">You are getting this because you have access to ${esc(artifact.title || 'this artifact')} on Astrodock.</p>
</div>`;
}

/** Run the `email` actions for one change. */
async function onChange(artifact, manifest, name, event, row, before, ctx) {
  for (const a of manifest.actions) {
    if (a.do !== 'email' || !a.on.some((o) => o.collection === name && o.event === event)) continue;
    const subjectRow = event === 'delete' ? before : row;
    if (a.when && (subjectRow.data || {})[a.when.field] !== a.when.is) continue;
    // On update, only when the condition just became true, so a later edit does
    // not send the same message again.
    if (a.when && event === 'update' && before && (before.data || {})[a.when.field] === a.when.is) continue;
    const to = (await recipients(artifact, manifest, a.to, subjectRow))
      .filter((e) => e !== access.normEmail(ctx.email));
    for (const email of to) {
      if (await sentToday(artifact.ownerId, 'action') >= config.artifacts.actionEmailsPerDay) {
        await logSend(artifact, 'action', email, 'capped');
        continue;
      }
      const subject = fill(a.subject, subjectRow).slice(0, 200);
      const lines = a.body ? [fill(a.body, subjectRow)] : [];
      try {
        await sendEmail({ to: email, subject, html: wrapper(artifact, subject, lines, config.artifactOrigin(artifact.publicId)) });
        await logSend(artifact, 'action', email, 'sent');
      } catch (err) {
        await logSend(artifact, 'action', email, 'failed');
        console.error('[artifacts] email action failed:', err.message);
      }
    }
  }
}

// ── digest ─────────────────────────────────────────────────────────────────
// Once a day, at the action's hour (UTC), a message to a role listing what was
// added or changed in a collection in the last day. Nothing changed, nothing sent.

function labelFor(row) {
  const d = row.data || {};
  for (const k of ['title', 'name', 'subject', 'text', 'body']) if (typeof d[k] === 'string' && d[k].trim()) return d[k].trim().slice(0, 120);
  const first = Object.values(d).find((v) => typeof v === 'string' && v.trim());
  return first ? first.trim().slice(0, 120) : 'A record';
}

async function runDigests(now = new Date()) {
  const hour = now.getUTCHours();
  const list = await db.select().from(schema.artifacts)
    .where(and(eq(schema.artifacts.isActive, true), sql`${schema.artifacts.manifest} -> 'actions' @> '[{"do":"digest"}]'::jsonb`));
  for (const artifact of list) {
    if (artifact.suspendedAt) continue;
    let manifest;
    try { manifest = M.normalize(artifact.manifest); } catch { continue; }
    for (const a of manifest.actions) {
      if (a.do !== 'digest' || a.hour !== hour) continue;
      const key = `digest:${a.collection}:${now.toISOString().slice(0, 10)}`;
      const [done] = await db.select({ id: schema.artifactSends.id }).from(schema.artifactSends)
        .where(and(eq(schema.artifactSends.artifactId, artifact.id), eq(schema.artifactSends.kind, 'digest-run'), eq(schema.artifactSends.recipient, key))).limit(1);
      if (done) continue;
      await logSend(artifact, 'digest-run', key, 'sent');
      const rows = await db.select().from(schema.artifactRecords)
        .where(and(eq(schema.artifactRecords.artifactId, artifact.id), eq(schema.artifactRecords.collection, a.collection),
          gt(schema.artifactRecords.updatedAt, new Date(now.getTime() - DAY_MS))))
        .orderBy(sql`updated_at desc`).limit(50);
      if (!rows.length) continue;
      // A per-user collection's records are private to their authors.
      if (manifest.collections[a.collection].scope === 'per-user') continue;
      const added = rows.filter((r) => r.createdAt > new Date(now.getTime() - DAY_MS));
      const changed = rows.filter((r) => !added.includes(r));
      const lines = [];
      if (added.length) lines.push(`Added (${added.length}):\n${added.slice(0, 20).map((r) => `• ${labelFor(r)}`).join('\n')}`);
      if (changed.length) lines.push(`Changed (${changed.length}):\n${changed.slice(0, 20).map((r) => `• ${labelFor(r)}`).join('\n')}`);
      const subject = `${artifact.title || 'Artifact'}: ${rows.length} update${rows.length === 1 ? '' : 's'} in ${a.collection}`;
      for (const email of await recipients(artifact, manifest, a.to, {})) {
        if (await sentToday(artifact.ownerId, 'action') >= config.artifacts.actionEmailsPerDay) { await logSend(artifact, 'action', email, 'capped'); continue; }
        try {
          await sendEmail({ to: email, subject, html: wrapper(artifact, subject, lines, config.artifactOrigin(artifact.publicId)) });
          await logSend(artifact, 'action', email, 'sent');
        } catch (err) {
          await logSend(artifact, 'action', email, 'failed');
          console.error('[artifacts] digest failed:', err.message);
        }
      }
    }
  }
}

let timer = null;
function startDigests() {
  if (timer) return;
  const tick = () => runDigests().catch((err) => console.error('[artifacts] digest run failed:', err.message));
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
}

/** Invitation emails, capped per owner per day. Returns 'sent' | 'capped' | 'failed'. */
async function sendInvite(artifact, email, inviter) {
  if (await sentToday(artifact.ownerId, 'invite') >= config.artifacts.invitesPerDay) {
    await logSend(artifact, 'invite', email, 'capped');
    return 'capped';
  }
  const title = artifact.title || 'an artifact';
  const who = inviter ? `${inviter} shared ${title} with you.` : `${title} was shared with you.`;
  try {
    await sendEmail({
      to: email,
      subject: `${inviter || 'Someone'} shared ${title} with you`,
      html: wrapper(artifact, `${title} was shared with you`, [who, 'Open it with the link below. You will get a sign-in code by email.'], config.artifactOrigin(artifact.publicId))
    });
    await logSend(artifact, 'invite', email, 'sent');
    return 'sent';
  } catch (err) {
    await logSend(artifact, 'invite', email, 'failed');
    console.error('[artifacts] invite failed:', err.message);
    return 'failed';
  }
}

module.exports = { onChange, runDigests, startDigests, sendInvite, fill, members, recipients, labelFor };
