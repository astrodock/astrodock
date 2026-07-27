// Scope expansion, delegation and role mapping. Run: node test/scopes.mjs
//
// Delegation is where an authorization mistake becomes privilege escalation, so
// the refusals matter more than the acceptances here.
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const S = require('../src/lib/scopes.js');
const R = require('../src/lib/roles.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `expected /${re.source}/`);

console.log('scope expansion');

test('legacy deploy expands to the deployer preset', () => {
  const e = S.expand(['deploy']);
  assert.ok(e.includes('deploys:write'));
  assert.ok(e.includes('env:write'));
  // The two things `deploy` could technically reach but nobody meant by it.
  assert.ok(!e.includes('apps:delete'), 'legacy deploy must not carry apps:delete forward');
  assert.ok(!e.includes('exec'), 'legacy deploy must not carry exec forward');
});

test('legacy pages maps to the pages scopes', () => {
  assert.deepStrictEqual(S.expand(['pages']).sort(), ['pages:read', 'pages:write']);
});

test('unknown scopes are rejected, not silently dropped', () => {
  throws(() => S.validate(['apps:read', 'nonsense']), /Unknown scope/);
  throws(() => S.validate([]), /At least one scope/);
});

test('no preset contains exec, tokens:write or apps:delete', () => {
  for (const [name, p] of Object.entries(S.PRESETS)) {
    for (const dangerous of ['exec', 'tokens:write']) {
      assert.ok(!p.scopes.includes(dangerous), `${name} must not include ${dangerous}`);
    }
  }
  assert.ok(!S.PRESETS.deployer.scopes.includes('apps:delete'));
});

console.log('\ndelegation');

const minter = (scopes, extra = {}) => ({ scopes, appScope: [], ...extra });

test('a key cannot grant what it does not hold', () => {
  throws(
    () => S.checkDelegation(minter(['tokens:write', 'apps:read', 'deploys:write']),
      { scopes: ['apps:read', 'settings:write'] }),
    /does not hold: settings:write/
  );
});

test('a key can never grant tokens:write — chains stop at depth one', () => {
  throws(
    () => S.checkDelegation(minter(['tokens:write', 'apps:read', 'apps:write']),
      { scopes: ['tokens:write', 'apps:read'] }),
    /cannot grant tokens:write/
  );
});

test('minting requires tokens:write', () => {
  throws(() => S.checkDelegation(minter(['apps:read']), { scopes: ['apps:read'] }), /cannot create other keys/);
});

test('a key cannot mint a copy of itself', () => {
  // Lateral, not delegated — the whole point of "strictly less".
  throws(
    () => S.checkDelegation(minter(['tokens:write', 'apps:read', 'deploys:write']),
      { scopes: ['apps:read', 'deploys:write'] }),
    /strictly less/
  );
});

test('a proper subset is allowed', () => {
  assert.doesNotThrow(() => S.checkDelegation(
    minter(['tokens:write', 'apps:read', 'apps:write', 'deploys:write', 'env:write']),
    { scopes: ['apps:read', 'deploys:write'] }
  ));
});

test('app scope cannot widen', () => {
  const m = minter(['tokens:write', 'apps:read', 'deploys:write'], { appScope: ['invoices'] });
  throws(() => S.checkDelegation(m, { scopes: ['apps:read'], appScope: ['invoices', 'crm'] }), /Outside this key/);
  throws(() => S.checkDelegation(m, { scopes: ['apps:read'], appScope: [] }), /limited to specific apps/);
  assert.doesNotThrow(() => S.checkDelegation(m, { scopes: ['apps:read'], appScope: ['invoices'] }));
});

test('a minted key cannot outlive its minter', () => {
  const soon = new Date(Date.now() + 3600e3);
  const later = new Date(Date.now() + 7200e3);
  const m = minter(['tokens:write', 'apps:read', 'deploys:write'], { expiresAt: soon });
  throws(() => S.checkDelegation(m, { scopes: ['apps:read'], expiresAt: later }), /cannot outlive/);
  throws(() => S.checkDelegation(m, { scopes: ['apps:read'] }), /cannot outlive/);
  assert.doesNotThrow(() => S.checkDelegation(m, { scopes: ['apps:read'], expiresAt: soon }));
});

test('a human is not bound by delegation limits', () => {
  assert.doesNotThrow(() => S.checkDelegation(null, { scopes: S.ALL }));
});

console.log('\noperator roles');

test('roles express the same vocabulary as keys', () => {
  for (const role of Object.keys(R.ROLES)) {
    for (const s of R.scopesFor(role)) {
      assert.ok(S.SCOPES[s], `${role} grants unknown scope ${s}`);
    }
  }
});

test('viewer is read-only and includes the audit trail', () => {
  const v = R.scopesFor('viewer');
  assert.ok(v.includes('events:read'), 'viewer sees the audit trail');
  assert.ok(!v.some((s) => s.endsWith(':write')), 'viewer writes nothing');
  assert.ok(!v.includes('exec'));
});

test('operator cannot manage users, keys or the platform', () => {
  const o = R.scopesFor('operator');
  ['users:write', 'tokens:write', 'platform:write', 'apps:delete', 'exec'].forEach((s) =>
    assert.ok(!o.includes(s), `operator must not hold ${s}`));
  assert.ok(o.includes('deploys:write'));
});

test('only an owner may change an owner', () => {
  assert.strictEqual(R.canManageUser({ role: 'admin' }, { operatorRole: 'owner' }).ok, false);
  assert.strictEqual(R.canManageUser({ role: 'owner' }, { operatorRole: 'owner' }).ok, true);
});

test('keys manage end users only, and never their own principal', () => {
  const auth = { authorizedByUserId: 'u1' };
  assert.strictEqual(R.keyCanManageUser(auth, { id: 'u2', operatorRole: 'admin' }).ok, false);
  assert.strictEqual(R.keyCanManageUser(auth, { id: 'u1', operatorRole: null }).ok, false, 'own principal');
  assert.strictEqual(R.keyCanManageUser(auth, { id: 'u2', operatorRole: null }).ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
