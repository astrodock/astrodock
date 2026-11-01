// What `deploy --local` uploads. Run: node test/upload-files-unit.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isExcluded, filesToUpload } = require('../src/upload-files.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

test('secrets and heavy folders are never uploaded', () => {
  for (const p of ['.env', '.env.local', '.env.production', 'server/.env.development', '.env.astrodock',
    'private/key.json', 'a/private/x', 'id.pem', 'certs/tls.KEY', '.npmrc', '.aws/credentials', '.ssh/id_ed25519',
    'node_modules/x/index.js', '.git/config', 'dist/index.html', '.DS_Store', '._app.json']) {
    assert.strictEqual(isExcluded(p), true, `${p} should be excluded`);
  }
  for (const p of ['app.json', 'server/server.js', '.env.example', 'server/.env.production.example', 'src/keys.js', '.gitignore']) {
    assert.strictEqual(isExcluded(p), false, `${p} should be uploaded`);
  }
});

test('outside git: the directory, minus the hard rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adock-up-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'private'));
    fs.writeFileSync(path.join(dir, 'app.json'), '{}');
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '');
    fs.writeFileSync(path.join(dir, 'private', 'secret.txt'), '');
    fs.writeFileSync(path.join(dir, 'tls.pem'), '');
    assert.deepStrictEqual(filesToUpload(dir).sort(), ['app.json', 'src/a.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inside git: what git would commit, minus the hard rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adock-up-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(dir, 'app.json'), '{}');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), '');
    fs.writeFileSync(path.join(dir, 'tls.pem'), '');
    assert.deepStrictEqual(filesToUpload(dir).sort(), ['.gitignore', 'app.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
