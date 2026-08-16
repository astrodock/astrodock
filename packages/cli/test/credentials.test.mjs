// Unit tests for src/credentials.js — pure filesystem + git, no control plane.
// Run directly: node packages/cli/test/credentials.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(fileURLToPath(import.meta.url));
const { loadCredentials, parseCredFile, CRED_FILE } = require('../src/credentials.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adock-creds-'));
}

// The suite must see only its own env, whatever the caller exported.
const savedUrl = process.env.ASTRODOCK_URL;
const savedToken = process.env.ASTRODOCK_TOKEN;
delete process.env.ASTRODOCK_URL;
delete process.env.ASTRODOCK_TOKEN;

try {
  ok('parses KEY=VALUE, skips comments, blanks and foreign keys', () => {
    const parsed = parseCredFile([
      '# comment',
      '',
      'ASTRODOCK_URL=https://admin.example.com',
      "ASTRODOCK_TOKEN='tk_quoted'",
      'SOME_OTHER=nope',
      'ASTRODOCK_EMPTY=',
      'not a kv line'
    ].join('\n'));
    assert.deepStrictEqual(parsed, {
      ASTRODOCK_URL: 'https://admin.example.com',
      ASTRODOCK_TOKEN: 'tk_quoted'
    });
  });

  ok('strips double quotes and ignores empty values', () => {
    const parsed = parseCredFile('ASTRODOCK_URL="https://x.example"\nASTRODOCK_TOKEN=\n');
    assert.deepStrictEqual(parsed, { ASTRODOCK_URL: 'https://x.example' });
  });

  ok('no file, no env → empty', () => {
    assert.deepStrictEqual(loadCredentials(tmpdir()), {});
  });

  ok('reads the file from cwd (not a git repo)', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, CRED_FILE),
      'ASTRODOCK_URL=https://admin.example.com\nASTRODOCK_TOKEN=tk_file\n');
    assert.deepStrictEqual(loadCredentials(dir), {
      ASTRODOCK_URL: 'https://admin.example.com',
      ASTRODOCK_TOKEN: 'tk_file'
    });
  });

  ok('environment variables win over the file', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, CRED_FILE),
      'ASTRODOCK_URL=https://file.example\nASTRODOCK_TOKEN=tk_file\n');
    process.env.ASTRODOCK_TOKEN = 'tk_env';
    try {
      const creds = loadCredentials(dir);
      assert.strictEqual(creds.ASTRODOCK_TOKEN, 'tk_env');
      assert.strictEqual(creds.ASTRODOCK_URL, 'https://file.example');
    } finally {
      delete process.env.ASTRODOCK_TOKEN;
    }
  });

  ok('a git-tracked credentials file is fatal', () => {
    const dir = tmpdir();
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, CRED_FILE), 'ASTRODOCK_TOKEN=tk_oops\n');
    git('add', CRED_FILE);
    assert.throws(() => loadCredentials(dir), /tracked by git/);
  });

  ok('a gitignored credentials file in a repo is fine', () => {
    const dir = tmpdir();
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, '.gitignore'), CRED_FILE + '\n');
    fs.writeFileSync(path.join(dir, CRED_FILE), 'ASTRODOCK_TOKEN=tk_fine\n');
    assert.deepStrictEqual(loadCredentials(dir), { ASTRODOCK_TOKEN: 'tk_fine' });
  });
} finally {
  if (savedUrl !== undefined) process.env.ASTRODOCK_URL = savedUrl;
  if (savedToken !== undefined) process.env.ASTRODOCK_TOKEN = savedToken;
}

console.log(`credentials: ${passed} tests passed`);
