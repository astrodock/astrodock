'use strict';

// The artifact manifest: roles, collections, blobs and built-in actions.
// See docs/artifacts.md for the format an agent writes.
//
// normalize() turns what an agent wrote into one fixed shape the server
// evaluates, and reports every problem at once with the path to it, so an
// agent can fix a manifest in one pass instead of one error per try.
//
// Pure: no database, no config. Unit-tested in test/artifacts-unit.mjs.

const ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ITEM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;   // collections, blobs
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED_ROLES = new Set(['author', 'public', 'anyone', 'me']);
const FIELD_TYPES = new Set(['string', 'text', 'number', 'integer', 'boolean', 'email', 'date', 'datetime', 'url', 'json', 'list']);
const COLLECTION_OPS = ['read', 'create', 'update', 'delete'];
const BLOB_OPS = ['read', 'write'];
const MAX_ROLES = 12;
const MAX_COLLECTIONS = 40;
const MAX_BLOBS = 40;
const MAX_FIELDS = 100;
const MAX_ACTIONS = 40;

const DEFAULT_ROLES = ['owner', 'editor', 'viewer'];

class ManifestError extends Error {
  constructor(problems) {
    super(`The manifest has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    this.problems = problems;
    this.status = 400;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalize a manifest. Returns the normalized form, or throws ManifestError.
 * An empty or missing manifest is valid: the default roles, no data.
 */
function normalize(input) {
  const problems = [];
  const bad = (path, message) => problems.push({ path, message });
  const m = input == null ? {} : input;
  if (!isObj(m)) throw new ManifestError([{ path: '$', message: 'must be a JSON object' }]);

  for (const k of Object.keys(m)) {
    if (!['roles', 'collections', 'blobs', 'actions', 'version'].includes(k)) bad(k, 'unknown key (allowed: roles, collections, blobs, actions)');
  }

  // ── roles: a ladder, highest first, owner on top ──
  let roles = DEFAULT_ROLES;
  if (m.roles !== undefined) {
    if (!Array.isArray(m.roles) || !m.roles.length) bad('roles', 'must be a non-empty list of role names, highest first');
    else {
      roles = m.roles.map((r) => String(r));
      if (roles[0] !== 'owner') bad('roles[0]', 'the first (highest) role must be "owner"');
      if (roles.length > MAX_ROLES) bad('roles', `at most ${MAX_ROLES} roles`);
      const seen = new Set();
      roles.forEach((r, i) => {
        if (!ROLE_NAME.test(r)) bad(`roles[${i}]`, `"${r}" is not a valid role name (lowercase letters, digits, - and _)`);
        if (RESERVED_ROLES.has(r)) bad(`roles[${i}]`, `"${r}" is reserved`);
        if (seen.has(r)) bad(`roles[${i}]`, `"${r}" is listed twice`);
        seen.add(r);
      });
    }
  }
  const lowest = roles[roles.length - 1];
  // Writes default to the role just above the lowest: with owner/editor/viewer,
  // editors write and viewers read. With one role, the owner.
  const defaultWrite = roles.length >= 2 ? roles[roles.length - 2] : roles[0];

  // ── collections ──
  const collections = {};
  if (m.collections !== undefined) {
    if (!isObj(m.collections)) bad('collections', 'must be an object of collection name → settings');
    else {
      const names = Object.keys(m.collections);
      if (names.length > MAX_COLLECTIONS) bad('collections', `at most ${MAX_COLLECTIONS} collections`);
      for (const name of names) {
        const path = `collections.${name}`;
        if (!ITEM_NAME.test(name)) { bad(path, 'name must start with a letter and use letters, digits and _'); continue; }
        const c = m.collections[name] == null ? {} : m.collections[name];
        if (!isObj(c)) { bad(path, 'must be an object'); continue; }
        for (const k of Object.keys(c)) {
          if (![...COLLECTION_OPS, 'scope', 'fields'].includes(k)) bad(`${path}.${k}`, 'unknown key (allowed: read, create, update, delete, scope, fields)');
        }
        const scope = c.scope === undefined ? 'shared' : c.scope;
        if (!['shared', 'per-user'].includes(scope)) bad(`${path}.scope`, 'must be "shared" or "per-user"');
        const fields = c.fields === undefined ? null : normalizeFields(c.fields, `${path}.fields`, bad);
        const rules = {};
        for (const op of COLLECTION_OPS) {
          const def = op === 'read' ? lowest : defaultWrite;
          rules[op] = normalizeRule(c[op] === undefined ? def : c[op], `${path}.${op}`, { roles, op, fields, kind: 'collection', bad });
        }
        collections[name] = { scope, fields, rules };
      }
    }
  }

  // ── blobs ──
  const blobs = {};
  if (m.blobs !== undefined) {
    if (!isObj(m.blobs)) bad('blobs', 'must be an object of blob name → settings');
    else {
      const names = Object.keys(m.blobs);
      if (names.length > MAX_BLOBS) bad('blobs', `at most ${MAX_BLOBS} blobs`);
      for (const name of names) {
        const path = `blobs.${name}`;
        if (!ITEM_NAME.test(name)) { bad(path, 'name must start with a letter and use letters, digits and _'); continue; }
        const b = m.blobs[name] == null ? {} : m.blobs[name];
        if (!isObj(b)) { bad(path, 'must be an object'); continue; }
        for (const k of Object.keys(b)) {
          if (![...BLOB_OPS, 'scope'].includes(k)) bad(`${path}.${k}`, 'unknown key (allowed: read, write, scope)');
        }
        const scope = b.scope === undefined ? 'shared' : b.scope;
        if (!['shared', 'per-user'].includes(scope)) bad(`${path}.scope`, 'must be "shared" or "per-user"');
        const rules = {};
        for (const op of BLOB_OPS) {
          const def = op === 'read' ? lowest : defaultWrite;
          rules[op] = normalizeRule(b[op] === undefined ? def : b[op], `${path}.${op}`, { roles, op, fields: null, kind: 'blob', bad });
        }
        blobs[name] = { scope, rules };
      }
    }
  }

  // ── actions ──
  const actions = [];
  if (m.actions !== undefined) {
    if (!Array.isArray(m.actions)) bad('actions', 'must be a list');
    else {
      if (m.actions.length > MAX_ACTIONS) bad('actions', `at most ${MAX_ACTIONS} actions`);
      m.actions.forEach((a, i) => {
        const out = normalizeAction(a, `actions[${i}]`, { roles, collections, bad });
        if (out) actions.push(out);
      });
    }
  }

  if (problems.length) throw new ManifestError(problems);
  return { version: 1, roles, collections, blobs, actions };
}

function normalizeFields(input, path, bad) {
  if (!isObj(input)) { bad(path, 'must be an object of field name → type'); return null; }
  const names = Object.keys(input);
  if (names.length > MAX_FIELDS) bad(path, `at most ${MAX_FIELDS} fields`);
  const out = {};
  for (const name of names) {
    const fp = `${path}.${name}`;
    if (!FIELD_NAME.test(name) || name === 'id') { bad(fp, name === 'id' ? '"id" is set by the server' : 'name must start with a letter and use letters, digits and _'); continue; }
    let spec = input[name];
    if (typeof spec === 'string') spec = { type: spec };
    if (!isObj(spec)) { bad(fp, 'must be a type name or { type, required, min, max, enum }'); continue; }
    for (const k of Object.keys(spec)) {
      if (!['type', 'required', 'min', 'max', 'enum'].includes(k)) bad(`${fp}.${k}`, 'unknown key (allowed: type, required, min, max, enum)');
    }
    if (!FIELD_TYPES.has(spec.type)) { bad(`${fp}.type`, `must be one of: ${[...FIELD_TYPES].join(', ')}`); continue; }
    const f = { type: spec.type, required: !!spec.required };
    for (const k of ['min', 'max']) {
      if (spec[k] !== undefined) {
        if (typeof spec[k] !== 'number' || !Number.isFinite(spec[k])) bad(`${fp}.${k}`, 'must be a number');
        else f[k] = spec[k];
      }
    }
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || !spec.enum.length || !spec.enum.every((v) => ['string', 'number'].includes(typeof v))) {
        bad(`${fp}.enum`, 'must be a non-empty list of strings or numbers');
      } else f.enum = spec.enum;
    }
    out[name] = f;
  }
  return out;
}

/**
 * A rule is who may do one operation. Written as a role name (that role and
 * every role above it), or a list whose entries each grant access:
 *   "staff"                         staff and above
 *   "author"                        whoever created the record
 *   "public"                        anyone, signed in or not (public artifacts, reads only)
 *   { "field": "assignee", "is": "me.email" }   records whose field holds the viewer's email
 */
function normalizeRule(input, path, { roles, op, fields, kind, bad }) {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) { bad(path, 'must name at least one role'); return []; }
  const out = [];
  list.forEach((e, i) => {
    const ep = Array.isArray(input) ? `${path}[${i}]` : path;
    if (typeof e === 'string') {
      if (e === 'author') {
        if (kind === 'blob') bad(ep, '"author" applies to collection records, not blobs');
        else if (op === 'create') bad(ep, '"author" cannot create: a record has no author until it exists');
        else out.push({ type: 'author' });
        return;
      }
      if (e === 'public') {
        if (op !== 'read') bad(ep, '"public" is allowed for read only: anonymous visitors cannot change data');
        else out.push({ type: 'public' });
        return;
      }
      const rank = roles.indexOf(e);
      if (rank === -1) { bad(ep, `"${e}" is not one of the roles (${roles.join(', ')})`); return; }
      out.push({ type: 'role', role: e, rank });
      return;
    }
    if (isObj(e) && e.field !== undefined) {
      if (kind === 'blob') { bad(ep, 'field rules apply to collection records, not blobs'); return; }
      if (op === 'create') { bad(ep, 'field rules cannot grant create'); return; }
      if (e.is !== 'me.email') { bad(`${ep}.is`, 'must be "me.email"'); return; }
      if (Object.keys(e).some((k) => !['field', 'is'].includes(k))) { bad(ep, 'a field rule has only "field" and "is"'); return; }
      if (!FIELD_NAME.test(String(e.field))) { bad(`${ep}.field`, 'not a valid field name'); return; }
      if (fields && !fields[e.field]) { bad(`${ep}.field`, `"${e.field}" is not in this collection's fields`); return; }
      if (fields && !['email', 'string'].includes(fields[e.field].type)) { bad(`${ep}.field`, `"${e.field}" must be an email or string field`); return; }
      out.push({ type: 'field', field: String(e.field) });
      return;
    }
    bad(ep, 'must be a role name, "author", "public", or { "field": …, "is": "me.email" }');
  });
  return out;
}

function parseOn(on, path, collections, bad) {
  const list = Array.isArray(on) ? on : [on];
  const out = [];
  for (const [i, e] of list.entries()) {
    const ep = Array.isArray(on) ? `${path}[${i}]` : path;
    const m = /^([A-Za-z][A-Za-z0-9_]{0,39})\.(create|update|delete)$/.exec(String(e || ''));
    if (!m) { bad(ep, 'must be "<collection>.<create|update|delete>"'); continue; }
    if (!collections[m[1]]) { bad(ep, `"${m[1]}" is not a collection in this manifest`); continue; }
    out.push({ collection: m[1], event: m[2] });
  }
  return out;
}

function normalizeWhen(w, path, bad) {
  if (w === undefined) return null;
  if (!isObj(w) || !FIELD_NAME.test(String(w.field || '')) || !('is' in w)) {
    bad(path, 'must be { "field": …, "is": value }');
    return null;
  }
  if (!['string', 'number', 'boolean'].includes(typeof w.is) && w.is !== null) { bad(`${path}.is`, 'must be a string, number, boolean or null'); return null; }
  return { field: w.field, is: w.is };
}

function normalizeTo(to, path, { roles, collections, on, bad }) {
  if (!isObj(to)) { bad(path, 'must be { "role": … } or { "field": … }'); return null; }
  if (to.role !== undefined) {
    if (!roles.includes(to.role)) { bad(`${path}.role`, `"${to.role}" is not one of the roles`); return null; }
    return { role: to.role, rank: roles.indexOf(to.role) };
  }
  if (to.field !== undefined) {
    for (const o of on) {
      const f = collections[o.collection] && collections[o.collection].fields;
      if (f && (!f[to.field] || f[to.field].type !== 'email')) { bad(`${path}.field`, `"${to.field}" must be an email field of ${o.collection}`); return null; }
    }
    return { field: String(to.field) };
  }
  if (to.author === true) return { author: true };
  bad(path, 'must be { "role": … }, { "field": … } or { "author": true }');
  return null;
}

/**
 * Built-in actions. The fixed list:
 *   email   send a message to a role, an email field, or the record's author on create/update/delete
 *   stamp   set a field to the time or the viewer's email on create/update
 *   digest  one daily email to a role listing what changed in a collection
 */
function normalizeAction(a, path, { roles, collections, bad }) {
  if (!isObj(a)) { bad(path, 'must be an object'); return null; }
  if (a.do === 'email') {
    const on = parseOn(a.on, `${path}.on`, collections, bad);
    const to = normalizeTo(a.to, `${path}.to`, { roles, collections, on, bad });
    if (typeof a.subject !== 'string' || !a.subject.trim() || a.subject.length > 200) bad(`${path}.subject`, 'must be text, at most 200 characters');
    if (a.body !== undefined && (typeof a.body !== 'string' || a.body.length > 4000)) bad(`${path}.body`, 'must be text, at most 4000 characters');
    const when = normalizeWhen(a.when, `${path}.when`, bad);
    return { do: 'email', on, to, subject: String(a.subject || ''), body: a.body || '', when };
  }
  if (a.do === 'stamp') {
    const on = parseOn(a.on, `${path}.on`, collections, bad);
    if (on.some((o) => o.event === 'delete')) bad(`${path}.on`, 'stamp runs on create or update');
    if (!FIELD_NAME.test(String(a.field || ''))) bad(`${path}.field`, 'must be a field name');
    const value = a.value === undefined ? 'now' : a.value;
    if (!['now', 'me.email'].includes(value)) bad(`${path}.value`, 'must be "now" or "me.email"');
    for (const o of on) {
      const f = collections[o.collection] && collections[o.collection].fields;
      if (f && !f[a.field]) bad(`${path}.field`, `"${a.field}" is not in ${o.collection}'s fields`);
    }
    const when = normalizeWhen(a.when, `${path}.when`, bad);
    return { do: 'stamp', on, field: String(a.field || ''), value, when };
  }
  if (a.do === 'digest') {
    if (!collections[a.collection]) bad(`${path}.collection`, 'must name a collection in this manifest');
    const to = normalizeTo(a.to, `${path}.to`, { roles, collections, on: [], bad });
    if (to && !to.role) bad(`${path}.to`, 'a digest goes to a role');
    const hour = a.hour === undefined ? 13 : a.hour;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) bad(`${path}.hour`, 'must be a whole hour, 0 to 23 (UTC)');
    return { do: 'digest', collection: String(a.collection || ''), to, hour };
  }
  bad(`${path}.do`, 'must be one of: email, stamp, digest');
  return null;
}

// ── evaluation ──────────────────────────────────────────────────────────────

function rankOf(manifest, role) {
  if (!role) return Infinity;
  const i = manifest.roles.indexOf(role);
  return i === -1 ? Infinity : i;
}

/**
 * What one rule grants a viewer, before looking at any record.
 *   { all: true }                          every record
 *   { all: false, author, fields: [...] }  only records matching these
 *   null                                   nothing
 * ctx: { role, userId, email } — role null for an anonymous visitor.
 */
function grant(rule, manifest, ctx) {
  const r = rankOf(manifest, ctx.role);
  let author = false;
  const fields = [];
  for (const e of rule) {
    if (e.type === 'public') return { all: true };
    if (e.type === 'role' && r <= e.rank) return { all: true };
    if (!ctx.userId) continue;
    if (e.type === 'author') author = true;
    if (e.type === 'field') fields.push(e.field);
  }
  if (author || fields.length) return { all: false, author, fields };
  return null;
}

function recordMatches(g, record, ctx) {
  if (!g) return false;
  if (g.all) return true;
  if (g.author && ctx.userId && record.authorId === ctx.userId) return true;
  const me = String(ctx.email || '').toLowerCase();
  if (me && g.fields.some((f) => String((record.data || {})[f] ?? '').toLowerCase() === me)) return true;
  return false;
}

/** The roles at or above `role` (who a { role } recipient means). */
function rolesAtOrAbove(manifest, role) {
  const i = manifest.roles.indexOf(role);
  return i === -1 ? [] : manifest.roles.slice(0, i + 1);
}

/**
 * A summary of what a viewer may do, for the client: true, false, or "some"
 * (only records they wrote or are named on).
 */
function permissions(manifest, ctx) {
  const level = (g) => (g ? (g.all ? true : 'some') : false);
  const out = { collections: {}, blobs: {} };
  for (const [name, c] of Object.entries(manifest.collections)) {
    out.collections[name] = Object.fromEntries(COLLECTION_OPS.map((op) => [op, level(grant(c.rules[op], manifest, ctx))]));
  }
  for (const [name, b] of Object.entries(manifest.blobs)) {
    out.blobs[name] = Object.fromEntries(BLOB_OPS.map((op) => [op, level(grant(b.rules[op], manifest, ctx))]));
  }
  return out;
}

// ── record validation ───────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkValue(name, spec, v) {
  if (v === null) return spec.required ? `${name} is required` : null;
  const t = spec.type;
  const len = (s) => (typeof s === 'string' ? s.length : 0);
  switch (t) {
    case 'string': case 'text':
      if (typeof v !== 'string') return `${name} must be text`;
      if (t === 'string' && v.length > (spec.max ?? 1000)) return `${name} is longer than ${spec.max ?? 1000} characters`;
      if (spec.max !== undefined && len(v) > spec.max) return `${name} is longer than ${spec.max} characters`;
      if (spec.min !== undefined && len(v) < spec.min) return `${name} is shorter than ${spec.min} characters`;
      break;
    case 'number': case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} must be a number`;
      if (t === 'integer' && !Number.isInteger(v)) return `${name} must be a whole number`;
      if (spec.max !== undefined && v > spec.max) return `${name} must be at most ${spec.max}`;
      if (spec.min !== undefined && v < spec.min) return `${name} must be at least ${spec.min}`;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return `${name} must be true or false`;
      break;
    case 'email':
      if (typeof v !== 'string' || !EMAIL.test(v) || v.length > 254) return `${name} must be an email address`;
      break;
    case 'date':
      if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) return `${name} must be a date, YYYY-MM-DD`;
      break;
    case 'datetime':
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return `${name} must be a date and time (ISO 8601)`;
      break;
    case 'url':
      if (typeof v !== 'string' || !/^https?:\/\/\S+$/.test(v) || v.length > 2000) return `${name} must be an http(s) URL`;
      break;
    case 'list':
      if (!Array.isArray(v)) return `${name} must be a list`;
      if (spec.max !== undefined && v.length > spec.max) return `${name} has more than ${spec.max} items`;
      break;
    case 'json':
      break;
    default:
      return `${name} has an unknown type`;
  }
  if (spec.enum && !spec.enum.includes(v)) return `${name} must be one of: ${spec.enum.join(', ')}`;
  return null;
}

/**
 * Check record data against a collection's fields. `partial` for an update,
 * where only the given fields are checked. Returns a list of problems.
 * With no fields declared, any JSON object is accepted.
 */
function validateData(collection, data, { partial = false } = {}) {
  const problems = [];
  if (!isObj(data)) return ['the record must be a JSON object'];
  for (const k of Object.keys(data)) {
    if (k === 'id' || k.startsWith('_')) problems.push(`"${k}" is set by the server`);
  }
  const fields = collection.fields;
  if (!fields) return problems;
  for (const k of Object.keys(data)) {
    if (k === 'id' || k.startsWith('_')) continue;
    if (!fields[k]) problems.push(`"${k}" is not a field of this collection`);
  }
  for (const [name, spec] of Object.entries(fields)) {
    if (!(name in data)) {
      if (!partial && spec.required) problems.push(`${name} is required`);
      continue;
    }
    const p = checkValue(name, spec, data[name]);
    if (p) problems.push(p);
  }
  return problems;
}

module.exports = {
  normalize, ManifestError, grant, recordMatches, permissions, rolesAtOrAbove, validateData, rankOf,
  DEFAULT_ROLES, ITEM_NAME, ROLE_NAME, FIELD_TYPES
};
