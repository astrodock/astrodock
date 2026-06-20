// Pure-logic unit tests for the `pages` CLI helpers (no network). Run: node test/pages-unit.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collect, resolveEntry, chunk } = require('../src/pages.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('pages CLI helpers');

test('collect: single file → basename rel', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-'));
  fs.writeFileSync(path.join(d, 'report.pdf'), 'x');
  const files = collect(path.join(d, 'report.pdf'));
  assert.deepStrictEqual(files.map((f) => f.rel), ['report.pdf']);
});

test('collect: directory → nested rel paths, skips dotfiles + node_modules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-'));
  fs.mkdirSync(path.join(d, 'assets'));
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'index.html'), 'x');
  fs.writeFileSync(path.join(d, 'assets', 'app.css'), 'x');
  fs.writeFileSync(path.join(d, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(d, '.env'), 'x');
  fs.writeFileSync(path.join(d, 'node_modules', 'junk.js'), 'x');
  const rels = collect(d).map((f) => f.rel).sort();
  assert.deepStrictEqual(rels, ['assets/app.css', 'index.html']);  // forward slashes; no dotfiles/node_modules
});

test('resolveEntry: prefers --entry, then index.html, then single, then first .html', () => {
  assert.strictEqual(resolveEntry({ entry: 'deck.pdf' }, ['a.html', 'deck.pdf'], 2), 'deck.pdf');
  assert.strictEqual(resolveEntry({}, ['a.css', 'index.html'], 2), 'index.html');
  assert.strictEqual(resolveEntry({}, ['report.pdf'], 1), 'report.pdf');
  assert.strictEqual(resolveEntry({}, ['a.css', 'b.html'], 2), 'b.html');
  assert.strictEqual(resolveEntry({}, ['a.css', 'b.js'], 2), 'a.css');
});

test('chunk: batches into groups', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(chunk([], 20), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
