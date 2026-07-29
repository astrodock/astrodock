// The parts of the self-update that touch the operator's disk.
//
// pinVersion rewrites .env on the host. Getting it wrong either pins the wrong
// version, loses an unrelated setting, or leaves a file that compose cannot
// parse — and it runs at the exact moment nobody is watching, in a container
// that is replacing the platform around itself.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrodock-update-'));
const ENV = path.join(dir, '.env');
process.env.ASTRODOCK_UPDATE_ENV_FILE = ENV;

const require = createRequire(import.meta.url);
const { pinVersion } = require('../src/runner/update-worker.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const write = (t) => fs.writeFileSync(ENV, t);
const read = () => fs.readFileSync(ENV, 'utf8');

console.log('self-update: pinning a version in .env');

try {
  test('adds the line when the install has always tracked latest', () => {
    write('ASTRODOCK_PG_PASSWORD=secret\nASTRODOCK_ADMIN_EMAIL=a@b.c\n');
    const previous = pinVersion('v0.0.8');
    assert.strictEqual(previous, null, 'there was no previous pin to report');
    assert.match(read(), /^ASTRODOCK_VERSION=v0\.0\.8$/m);
    // and nothing else was disturbed
    assert.match(read(), /^ASTRODOCK_PG_PASSWORD=secret$/m);
    assert.match(read(), /^ASTRODOCK_ADMIN_EMAIL=a@b\.c$/m);
  });

  test('replaces an existing pin and reports what it was', () => {
    write('ASTRODOCK_VERSION=v0.0.6\nASTRODOCK_PG_PASSWORD=secret\n');
    const previous = pinVersion('v0.0.8');
    assert.strictEqual(previous, 'v0.0.6');
    assert.match(read(), /^ASTRODOCK_VERSION=v0\.0\.8$/m);
    assert.doesNotMatch(read(), /v0\.0\.6/, 'the old pin is still in the file');
    assert.match(read(), /^ASTRODOCK_PG_PASSWORD=secret$/m);
  });

  test('a rollback restores the previous pin exactly', () => {
    write('ASTRODOCK_VERSION=v0.0.6\nASTRODOCK_PG_PASSWORD=secret\n');
    const previous = pinVersion('v0.0.8');
    pinVersion(previous);
    assert.match(read(), /^ASTRODOCK_VERSION=v0\.0\.6$/m);
  });

  test('a rollback on a latest-tracking install removes the line again', () => {
    // Otherwise an install that tracked `latest` would be silently pinned to the
    // version that failed, and never move again.
    write('ASTRODOCK_PG_PASSWORD=secret\n');
    const previous = pinVersion('v0.0.8');
    assert.strictEqual(previous, null);
    pinVersion(null);
    assert.doesNotMatch(read(), /ASTRODOCK_VERSION/, 'the pin outlived the rollback');
    assert.match(read(), /^ASTRODOCK_PG_PASSWORD=secret$/m);
  });

  test('a file with no trailing newline does not get two settings on one line', () => {
    write('ASTRODOCK_PG_PASSWORD=secret');
    pinVersion('v0.0.8');
    const lines = read().split('\n').filter(Boolean);
    assert.deepStrictEqual(lines, ['ASTRODOCK_PG_PASSWORD=secret', 'ASTRODOCK_VERSION=v0.0.8']);
  });

  test('only the exact key matches, not one that merely contains it', () => {
    write('ASTRODOCK_VERSION_CHECK=on\nASTRODOCK_PG_PASSWORD=secret\n');
    const previous = pinVersion('v0.0.8');
    assert.strictEqual(previous, null, 'ASTRODOCK_VERSION_CHECK is a different setting');
    assert.match(read(), /^ASTRODOCK_VERSION_CHECK=on$/m, 'it was overwritten');
    assert.match(read(), /^ASTRODOCK_VERSION=v0\.0\.8$/m);
  });

  test('a missing .env is created rather than throwing', () => {
    fs.rmSync(ENV, { force: true });
    pinVersion('v0.0.8');
    assert.match(read(), /^ASTRODOCK_VERSION=v0\.0\.8$/m);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nself-update: which installs can be updated from the dashboard');

const { classify } = require('../src/lib/self-update.js');
const L = (o) => ({
  'com.docker.compose.project': 'astrodock',
  'com.docker.compose.project.working_dir': '/opt/astrodock',
  'com.docker.compose.project.config_files': '/opt/astrodock/docker-compose.yml',
  ...o
});

test('a normal image install can be updated', () => {
  const r = classify(L());
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.project, 'astrodock');
  assert.strictEqual(r.workingDir, '/opt/astrodock');
});

test('a source build is refused, with a reason that says what to do instead', () => {
  // `compose up` would try to rebuild from a tree the container cannot see.
  const r = classify(L({
    'com.docker.compose.project.config_files':
      '/opt/astrodock/docker-compose.yml,/opt/astrodock/docker-compose.build.yml'
  }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /from source/i);
  assert.match(r.reason, /git pull/i);
});

test('a container not started by compose is refused', () => {
  assert.strictEqual(classify({}).ok, false);
  assert.match(classify({}).reason, /not started by Docker Compose/i);
  // a project name with no working directory is just as unusable
  assert.strictEqual(classify({ 'com.docker.compose.project': 'astrodock' }).ok, false);
});

test('a project renamed at install time is still updatable', () => {
  // Installing alongside another stack sets a different project name; the update
  // has to follow it rather than assuming "astrodock".
  const r = classify(L({
    'com.docker.compose.project': 'astrodock2',
    'com.docker.compose.project.working_dir': '/opt/astrodock2'
  }));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.project, 'astrodock2');
});

test('a path merely containing the words is not mistaken for a build overlay', () => {
  const r = classify(L({
    'com.docker.compose.project.config_files': '/srv/docker-compose.build.yml.bak/docker-compose.yml'
  }));
  assert.strictEqual(r.ok, true, r.reason);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
