// What keeps app code from becoming root on the runner: the ids app users get,
// where generated config lives, and that no app operation falls back to root.
// The parts that need useradd and a real Docker socket run on a server; these
// are the rules they follow.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-runner-'));
process.env.PM2_HOME = tmp;
process.env.ASTRODOCK_APP_CONFIG_DIR = path.join(tmp, 'app-config');

const require = createRequire(import.meta.url);
const appUser = require('../src/runner/app-user.js');
const appOps = require('../src/runner/app-ops.js');
const boot = require('../src/runner/boot.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('app user ids');
test('an app\'s preferred id is in the high range and the same every time', () => {
  for (const slug of ['a', 'oncall', 'ledger', 'x-very-long-slug-name-for-testing-0123456']) {
    const id = appUser.preferredId(slug);
    assert.ok(id >= appUser.ID_MIN && id < appUser.ID_MIN + appUser.ID_SPAN, `${slug} → ${id}`);
    assert.strictEqual(id, appUser.preferredId(slug));
  }
});
test('the old system ids (999 and down) are not safe', () => {
  assert.strictEqual(appUser.safeIds({ uid: 999, gid: 999 }), false);
  assert.strictEqual(appUser.safeIds({ uid: 995, gid: 995 }), false);
});
test('root is never safe', () => {
  assert.strictEqual(appUser.safeIds({ uid: 0, gid: 0 }), false);
  assert.strictEqual(appUser.safeIds({ uid: 25000, gid: 0 }), false);
});
test('ids in the range are safe', () => {
  assert.strictEqual(appUser.safeIds({ uid: 25000, gid: 25000 }), true);
  assert.strictEqual(appUser.safeIds(null), false);
});
test('the user name is derived from the slug', () => {
  assert.strictEqual(appUser.nameFor('my-app'), 'tsapp_my_app');
});

console.log('\ngenerated config location');
test('config files sit in the root-only folder, not the app\'s tree', () => {
  const f = appUser.appConfigFile('oncall', 'pm2.json');
  assert.strictEqual(f, path.join(tmp, 'app-config', 'oncall.pm2.json'));
  assert.strictEqual(fs.statSync(path.join(tmp, 'app-config')).mode & 0o777, 0o700);
});
test('a slug cannot walk out of that folder', () => {
  for (const bad of ['../x', 'a/b', '..', '', 'A']) {
    assert.throws(() => appUser.appConfigFile(bad, 'pm2.json'), /Bad app slug/, bad);
  }
});

console.log('\nno app operation runs as root');
test('a Dockerfile app is reached through its own container', () => {
  assert.strictEqual(appOps.accessFor({ slug: 'web', runtimeType: 'docker' }).kind, 'docker');
});
test('a Node app in a container is reached through its container', () => {
  assert.strictEqual(appOps.accessFor({ slug: 'web', runtimeType: 'node', nodeIsolation: 'container' }).kind, 'container');
});
test('a PM2 app with no user of its own is refused, not run as root', () => {
  assert.throws(() => appOps.accessFor({ slug: 'no-such-user-here', runtimeType: 'node', nodeIsolation: 'pm2' }), /Redeploy/);
});
test('the terminal refuses the same app instead of spawning a root shell', () => {
  const res = { write() {}, end() {}, on() {} };
  assert.throws(() => appOps.runInteractive({ slug: 'no-such-user-here', runtimeType: 'node' }, [], 'id', res), /Redeploy/);
});

console.log('\nrunner boot');
test('boot reads the PM2 apps to restore from the dump, and ignores odd names', () => {
  fs.writeFileSync(path.join(tmp, 'dump.pm2'), JSON.stringify([{ name: 'oncall' }, { name: 'ledger' }, { name: '../etc' }, { name: 'oncall' }]));
  assert.deepStrictEqual(boot.pm2Apps().sort(), ['ledger', 'oncall']);
});
test('no dump means nothing to restore', () => {
  fs.rmSync(path.join(tmp, 'dump.pm2'));
  assert.deepStrictEqual(boot.pm2Apps(), []);
});

console.log('\ndeploy inputs from the database');
const { checkDeployInputs } = require('../src/runner/deploy-worker.js');
const okApp = { slug: 'web', branch: 'main', githubRepo: 'acme/web', repoPath: 'apps/web', dockerfile: 'Dockerfile' };
test('ordinary values pass', () => {
  checkDeployInputs(okApp, { commitHash: 'abc1234' }, null);
  checkDeployInputs({ ...okApp, branch: 'feature/x-1.2' }, { commitHash: 'local' }, 'deadbeefcafe');
});
test('a branch with shell in it is refused', () => {
  assert.throws(() => checkDeployInputs({ ...okApp, branch: 'main"; id; "' }, {}, null), /branch/);
  assert.throws(() => checkDeployInputs({ ...okApp, branch: '--upload-pack=x' }, {}, null), /branch/);
});
test('a commit that is not hex is refused', () => {
  assert.throws(() => checkDeployInputs(okApp, { commitHash: '$(id)' }, null), /commit/);
  assert.throws(() => checkDeployInputs(okApp, {}, 'HEAD; id'), /target commit/);
});
test('paths cannot climb out or start a flag', () => {
  assert.throws(() => checkDeployInputs({ ...okApp, dockerfile: '../../etc/x' }, {}, null), /Dockerfile/);
  assert.throws(() => checkDeployInputs({ ...okApp, repoPath: '-x' }, {}, null), /repository path/);
  assert.throws(() => checkDeployInputs({ ...okApp, githubRepo: 'a/b c' }, {}, null), /repository/);
});

console.log('\nredirect targets');
const { parseRedirects } = require('../src/provision/caddy.js');
test('a target with a Caddy placeholder is refused', () => {
  const { redirects, errors } = parseRedirects('get https://evil.example/{env.ASTRODOCK_SECRET_KEY}\nok https://example.com');
  assert.deepStrictEqual(redirects.map((r) => r.name), ['ok']);
  assert.strictEqual(errors.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
