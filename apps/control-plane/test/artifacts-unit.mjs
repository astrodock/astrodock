// Artifacts: the pieces that need no database. The manifest, the rules, record
// validation, stamps, host routing and the Caddy block.

import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'artifacts-unit';
process.env.ASTRODOCK_BASE_DOMAIN = 'example.com';
process.env.ASTRODOCK_TLS_MODE = 'auto';
delete process.env.ASTRODOCK_ARTIFACTS_DOMAIN;

const M = require('../src/lib/artifacts/manifest.js');
const config = require('../src/config.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}
const problemsOf = (m) => { try { M.normalize(m); return []; } catch (e) { if (!e.problems) throw e; return e.problems; } };
const paths = (m) => problemsOf(m).map((p) => p.path);

const TASKS = {
  roles: ['owner', 'manager', 'staff', 'viewer'],
  collections: {
    tasks: {
      read: 'viewer',
      create: 'staff',
      update: ['manager', 'author', { field: 'assignee', is: 'me.email' }],
      delete: ['owner', 'author'],
      fields: { title: { type: 'string', required: true, max: 20 }, done: 'boolean', assignee: 'email', status: { type: 'string', enum: ['open', 'done'] }, completedAt: 'datetime' }
    },
    notes: { scope: 'per-user' },
    board: { read: ['public'], create: 'viewer' }
  },
  blobs: { settings: { read: 'viewer', write: 'owner' } },
  actions: [
    { on: 'tasks.create', do: 'email', to: { field: 'assignee' }, subject: 'New: {{title}}' },
    { on: ['tasks.create', 'tasks.update'], do: 'stamp', field: 'completedAt', when: { field: 'done', is: true } },
    { do: 'digest', collection: 'tasks', to: { role: 'manager' } }
  ]
};

console.log('manifest');

test('an empty manifest is the default ladder with no data', () => {
  const m = M.normalize({});
  assert.deepStrictEqual(m.roles, ['owner', 'editor', 'viewer']);
  assert.deepStrictEqual(m.collections, {});
  assert.deepStrictEqual(M.normalize(null).roles, ['owner', 'editor', 'viewer']);
});

test('a full manifest normalizes', () => {
  const m = M.normalize(TASKS);
  assert.strictEqual(m.collections.tasks.rules.read[0].role, 'viewer');
  assert.strictEqual(m.collections.tasks.fields.done.type, 'boolean');
  assert.strictEqual(m.actions.length, 3);
  assert.strictEqual(m.actions[2].hour, 13, 'digest defaults to 13:00 UTC');
});

test('defaults: read for every role, writes from the role above the lowest', () => {
  const m = M.normalize({ collections: { x: {} } });
  assert.deepStrictEqual(m.collections.x.rules.read, [{ type: 'role', role: 'viewer', rank: 2 }]);
  assert.deepStrictEqual(m.collections.x.rules.create, [{ type: 'role', role: 'editor', rank: 1 }]);
  const solo = M.normalize({ roles: ['owner'], collections: { x: {} } });
  assert.strictEqual(solo.collections.x.rules.create[0].role, 'owner');
});

test('every problem is reported at once, with its path', () => {
  const p = paths({
    roles: ['admin', 'viewer', 'viewer', 'author'],
    collections: { 'bad name': {}, ok: { read: 'nobody', create: 'author', extra: 1, fields: { x: 'colour' } } },
    actions: [{ do: 'webhook' }],
    other: true
  });
  for (const want of ['other', 'roles[0]', 'roles[2]', 'roles[3]', 'collections.bad name', 'collections.ok.extra', 'collections.ok.fields.x.type', 'collections.ok.read', 'collections.ok.create', 'actions[0].do']) {
    assert.ok(p.includes(want), `expected a problem at ${want}; got ${p.join(', ')}`);
  }
});

test('"public" is for reads only; "author" and field rules cannot create', () => {
  assert.ok(paths({ collections: { x: { create: 'public' } } }).includes('collections.x.create'));
  assert.ok(paths({ collections: { x: { create: ['author'] } } }).includes('collections.x.create[0]'));
  assert.ok(paths({ collections: { x: { create: [{ field: 'a', is: 'me.email' }] } } }).includes('collections.x.create[0]'));
  assert.ok(paths({ blobs: { s: { read: 'author' } } }).includes('blobs.s.read'));
});

test('field rules must name an email or string field, compared to me.email', () => {
  const base = { fields: { n: 'number', who: 'email' } };
  assert.ok(paths({ collections: { x: { ...base, update: [{ field: 'n', is: 'me.email' }] } } }).includes('collections.x.update[0].field'));
  assert.ok(paths({ collections: { x: { ...base, update: [{ field: 'missing', is: 'me.email' }] } } }).includes('collections.x.update[0].field'));
  assert.ok(paths({ collections: { x: { ...base, update: [{ field: 'who', is: 'me.id' }] } } }).includes('collections.x.update[0].is'));
  assert.deepStrictEqual(problemsOf({ collections: { x: { ...base, update: [{ field: 'who', is: 'me.email' }] } } }), []);
});

test('actions are checked against the collections they name', () => {
  assert.ok(paths({ actions: [{ on: 'nope.create', do: 'email', to: { role: 'owner' }, subject: 's' }] }).includes('actions[0].on'));
  assert.ok(paths({ collections: { t: { fields: { a: 'string' } } }, actions: [{ on: 't.create', do: 'email', to: { field: 'a' }, subject: 's' }] }).includes('actions[0].to.field'));
  assert.ok(paths({ collections: { t: {} }, actions: [{ on: 't.delete', do: 'stamp', field: 'x' }] }).includes('actions[0].on'));
  assert.ok(paths({ collections: { t: {} }, actions: [{ do: 'digest', collection: 't', to: { field: 'x' } }] }).includes('actions[0].to'));
  assert.ok(paths({ collections: { t: {} }, actions: [{ do: 'digest', collection: 't', to: { role: 'owner' }, hour: 24 }] }).includes('actions[0].hour'));
});

test('attachments: true, or limits and types, checked', () => {
  const m = M.normalize({ collections: { a: { attachments: true }, b: { attachments: { max: 3, types: ['image/*'] } } } });
  assert.deepStrictEqual(m.collections.a.attachments, { max: 10, maxBytes: 10485760, types: null });
  assert.strictEqual(m.collections.b.attachments.max, 3);
  assert.ok(M.typeAllowed(m.collections.b.attachments, 'image/png; charset=binary'));
  assert.ok(!M.typeAllowed(m.collections.b.attachments, 'text/html'));
  assert.ok(M.typeAllowed(m.collections.a.attachments, 'text/html'), 'no types: anything, served as a download');
  assert.strictEqual(M.normalize({ collections: { c: {} } }).collections.c.attachments, null);
  const p = paths({ collections: { x: { attachments: { max: 0, types: ['images'], extra: 1 } } } });
  for (const want of ['collections.x.attachments.max', 'collections.x.attachments.types', 'collections.x.attachments.extra']) assert.ok(p.includes(want), want);
});

console.log('rules');
const m = M.normalize(TASKS);
const ctx = (role, extra = {}) => ({ role, userId: role ? `u-${role}` : null, email: role ? `${role}@x.com` : null, ...extra });

test('the ladder: a role can do what the roles below it can', () => {
  const read = m.collections.tasks.rules.read;
  for (const r of ['owner', 'manager', 'staff', 'viewer']) assert.deepStrictEqual(M.grant(read, m, ctx(r)), { all: true }, r);
  const create = m.collections.tasks.rules.create;
  assert.deepStrictEqual(M.grant(create, m, ctx('staff')), { all: true });
  assert.strictEqual(M.grant(create, m, ctx('viewer')), null);
  assert.strictEqual(M.grant(read, m, ctx(null)), null, 'an anonymous visitor gets nothing without "public"');
});

test('author and field rules grant only matching records', () => {
  const update = m.collections.tasks.rules.update;
  const g = M.grant(update, m, ctx('staff'));
  assert.deepStrictEqual(g, { all: false, author: true, fields: ['assignee'] });
  const me = ctx('staff');
  assert.ok(M.recordMatches(g, { authorId: me.userId, data: {} }, me), 'their own record');
  assert.ok(M.recordMatches(g, { authorId: 'someone', data: { assignee: 'STAFF@x.com' } }, me), 'assigned to them, any case');
  assert.ok(!M.recordMatches(g, { authorId: 'someone', data: { assignee: 'other@x.com' } }, me));
  assert.deepStrictEqual(M.grant(update, m, ctx('manager')), { all: true });
});

test('"public" lets anonymous visitors read', () => {
  assert.deepStrictEqual(M.grant(m.collections.board.rules.read, m, ctx(null)), { all: true });
});

test('a role the manifest does not have gets nothing', () => {
  assert.strictEqual(M.grant(m.collections.tasks.rules.read, m, ctx('ghost')), null);
});

test('permissions summarize true, false and "some"', () => {
  const p = M.permissions(m, ctx('staff'));
  assert.deepStrictEqual(p.collections.tasks, { read: true, create: true, update: 'some', delete: 'some' });
  assert.deepStrictEqual(p.blobs.settings, { read: true, write: false });
  const v = M.permissions(m, ctx('viewer'));
  assert.strictEqual(v.collections.tasks.create, false);
});

console.log('records');
const tasks = m.collections.tasks;

test('fields: required, types, max, enum, unknown, server-set', () => {
  assert.deepStrictEqual(M.validateData(tasks, { title: 'Call' }), []);
  assert.ok(M.validateData(tasks, {}).includes('title is required'));
  assert.ok(M.validateData(tasks, { title: 'x'.repeat(21) }).some((p) => p.includes('longer than 20')));
  assert.ok(M.validateData(tasks, { title: 'a', done: 'yes' }).some((p) => p.includes('true or false')));
  assert.ok(M.validateData(tasks, { title: 'a', assignee: 'nope' }).some((p) => p.includes('email address')));
  assert.ok(M.validateData(tasks, { title: 'a', status: 'later' }).some((p) => p.includes('one of')));
  assert.ok(M.validateData(tasks, { title: 'a', colour: 'red' }).some((p) => p.includes('not a field')));
  assert.ok(M.validateData(tasks, { title: 'a', _author: 'me' }).some((p) => p.includes('set by the server')));
  assert.deepStrictEqual(M.validateData(tasks, { done: true }, { partial: true }), [], 'an update checks only what it sends');
  assert.ok(M.validateData(tasks, { title: null }, { partial: true }).includes('title is required'));
});

test('no fields declared: any object, but not server-set keys', () => {
  const free = M.normalize({ collections: { x: {} } }).collections.x;
  assert.deepStrictEqual(M.validateData(free, { anything: { nested: [1, 2] } }), []);
  assert.ok(M.validateData(free, { id: 'x' }).length);
  assert.ok(M.validateData(free, ['list']).length);
});

test('stamps follow their condition', () => {
  const { applyStamps } = require('../src/lib/artifacts/records.js');
  const done = applyStamps(m, 'tasks', 'update', { title: 'a', done: true }, ctx('staff'));
  assert.ok(done.completedAt && !Number.isNaN(Date.parse(done.completedAt)));
  const first = done.completedAt;
  const again = applyStamps(m, 'tasks', 'update', { ...done }, ctx('staff'));
  assert.strictEqual(again.completedAt, first, 'kept while the condition holds');
  const undone = applyStamps(m, 'tasks', 'update', { ...done, done: false }, ctx('staff'));
  assert.strictEqual(undone.completedAt, null, 'cleared when it stops holding');
  const by = M.normalize({ collections: { t: {} }, actions: [{ on: 't.update', do: 'stamp', field: 'editedBy', value: 'me.email' }] });
  assert.strictEqual(applyStamps(by, 't', 'update', {}, ctx('staff')).editedBy, 'staff@x.com');
});

test('email templates fill fields and nothing else', () => {
  const { fill } = require('../src/lib/artifacts/actions.js');
  assert.strictEqual(fill('New: {{title}} for {{ assignee }}{{missing}}{{obj}}', { data: { title: 'A', assignee: 'b@x.com', obj: { a: 1 } } }), 'New: A for b@x.com');
  assert.strictEqual(fill('{{_author}}', { data: {}, authorEmail: 'a@x.com' }), 'a@x.com');
});

console.log('hosts and routing');

test('artifact hosts are <12 characters>.<artifacts domain>', () => {
  assert.strictEqual(config.artifacts.domain, 'artifacts.example.com');
  assert.strictEqual(config.artifactIdForHost('abcdef123456.artifacts.example.com'), 'abcdef123456');
  assert.strictEqual(config.artifactIdForHost('ABCDEF123456.artifacts.example.com'), 'abcdef123456');
  assert.strictEqual(config.artifactIdForHost('short.artifacts.example.com'), null);
  assert.strictEqual(config.artifactIdForHost('a.b.artifacts.example.com'), null);
  assert.strictEqual(config.artifactIdForHost('abcdef123456.example.com'), null);
  assert.strictEqual(config.artifactOrigin('abcdef123456'), 'https://abcdef123456.artifacts.example.com');
});

test('a domain of its own (adock.app) when set', () => {
  const saved = config.artifacts.domainOverride;
  config.artifacts.domainOverride = 'adock.app';
  config.applyRuntimeDomain({});
  try {
    assert.strictEqual(config.artifactIdForHost('abcdef123456.adock.app'), 'abcdef123456');
    assert.strictEqual(config.artifactIdForHost('abcdef123456.artifacts.example.com'), null);
  } finally {
    config.artifacts.domainOverride = saved;
    config.applyRuntimeDomain({});
  }
});

test('public ids are 12 lowercase letters and digits', () => {
  const A = require('../src/lib/artifacts/access.js');
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = A.generatePublicId();
    assert.match(id, /^[a-z0-9]{12}$/);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 500);
});

test('Caddy serves every artifact host through the control plane, with on-demand certificates', () => {
  const { generateCaddyfile } = require('../src/provision/caddy.js');
  const out = generateCaddyfile([], {});
  assert.match(out, /\*\.artifacts\.example\.com \{\n\ttls \{\n\t\ton_demand\n\t\}\n\treverse_proxy api:3100\n\}/);
  assert.match(out, /on_demand_tls \{\n\t\task /);
  assert.match(out, /handle \/artifacts\/\* \{/, 'the sign-in pages are on the auth host');
});

test('the client library parses and the guide names the feedback rule', () => {
  const js = fs.readFileSync(new URL('../src/assets/artifacts-client.js', import.meta.url), 'utf8');
  new Function(js);
  const guide = fs.readFileSync(new URL('../src/assets/artifacts-guide.md', import.meta.url), 'utf8');
  assert.match(guide, /POST \/admin\/artifacts\/feedback/);
  assert.ok(!guide.includes('—'), 'no em-dashes in the published guide');
});

test('scopes: artifacts:admin is withheld from the operator role and every preset', () => {
  const roles = require('../src/lib/roles.js');
  const scopes = require('../src/lib/scopes.js');
  assert.ok(roles.scopesFor('admin').includes('artifacts:admin'));
  assert.ok(!roles.scopesFor('operator').includes('artifacts:admin'));
  assert.ok(roles.scopesFor('operator').includes('artifacts:write'));
  assert.ok(roles.scopesFor('viewer').includes('artifacts:read') && !roles.scopesFor('viewer').includes('artifacts:write'));
  for (const [k, p] of Object.entries(scopes.PRESETS)) {
    if (k === 'platform') continue;
    assert.ok(!p.scopes.includes('artifacts:admin'), k);
  }
  assert.deepStrictEqual(scopes.PRESETS.artifacts.scopes, ['artifacts:read', 'artifacts:write']);
});

console.log('logging');

test('the client script goes at the top of <head>, or after the doctype', () => {
  const { injectClient } = require('../src/routes/artifacts-public.js');
  const tag = '<script src="/_astrodock/client.js"></script>';
  assert.strictEqual(injectClient('<html><head lang="x"><title>a</title></head></html>'), `<html><head lang="x">${tag}<title>a</title></head></html>`);
  assert.strictEqual(injectClient('<!DOCTYPE html><p>x'), `<!DOCTYPE html>${tag}<p>x`);
  assert.strictEqual(injectClient('<p>x'), `${tag}<p>x`);
});

test('data calls are named from their path', () => {
  const { describe } = require('../src/routes/artifacts-public.js');
  const d = (method, path) => describe({ method, path });
  assert.deepStrictEqual(d('GET', '/c/tasks'), { op: 'list', target: 'tasks' });
  assert.deepStrictEqual(d('POST', '/c/tasks'), { op: 'create', target: 'tasks' });
  assert.deepStrictEqual(d('PATCH', '/c/tasks/abc'), { op: 'update', target: 'tasks', recordId: 'abc' });
  assert.deepStrictEqual(d('GET', '/c/tasks/_count'), { op: 'count', target: 'tasks' });
  assert.deepStrictEqual(d('PUT', '/b/settings'), { op: 'blob.set', target: 'settings' });
  assert.deepStrictEqual(d('GET', '/me'), { op: 'me' });
});

test('errors group across ids and numbers, not across messages', () => {
  const { fingerprint, truncateIp } = require('../src/lib/artifacts/logs.js');
  assert.strictEqual(fingerprint('api', '404 get tasks: no record 1234', ''), fingerprint('api', '404 get tasks: no record 98765', ''));
  assert.strictEqual(fingerprint('api', 'id 0b1c2d3e-1111-2222-3333-444455556666', ''), fingerprint('api', 'id 9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff', ''));
  assert.notStrictEqual(fingerprint('error', 'x is not defined', 'a.js:1'), fingerprint('error', 'y is not defined', 'a.js:1'));
  assert.strictEqual(truncateIp('203.0.113.77'), '203.0.113.0');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
