#!/usr/bin/env node
'use strict';

// Keeps the design system consistent. Run: node scripts/check.js
//
// kit.css, outside the token blocks:
//   - no raw colors (hex, rgb, hsl), radii, font sizes, font weights, z-indexes
//     or shadow colors: only var(--token)
// Preview pages and the catalog (what apps copy from):
//   - every class used is defined in kit.css (or preview.css for preview-only
//     scaffolding)
//   - no inline styles, except setting a custom property for a data value
//     (style="--value: 32%")
//   - no native <select>
//   - avatars, tiles and timeline marks use .avatar, never a circle

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const problems = [];
const report = (file, line, msg) => problems.push(`${file}${line ? `:${line}` : ''}  ${msg}`);

// ---------------------------------------------------------------- kit.css
const kit = fs.readFileSync(path.join(root, 'kit.css'), 'utf8');
const startTokens = kit.indexOf('/* ================================================================ 1. tokens */');
const endTokens = kit.indexOf('/* ================================================================ 2. base */');
if (startTokens < 0 || endTokens < 0) report('kit.css', 0, 'token section markers are missing');

kit.split('\n').forEach((raw, i) => {
  const offset = kit.split('\n').slice(0, i).join('\n').length;
  if (offset >= startTokens && offset < endTokens) return;
  const line = raw.replace(/\/\*.*?\*\//g, '').replace(/url\("data:[^"]*"\)/g, 'url()');
  const n = i + 1;
  if (/#[0-9a-fA-F]{3,8}\b/.test(line)) report('kit.css', n, `raw color: ${raw.trim()}`);
  if (/\b(rgba?|hsla?)\(/.test(line)) report('kit.css', n, `raw color: ${raw.trim()}`);
  const radius = line.match(/border-radius:\s*([^;}]+)/);
  if (radius && /\d+px/.test(radius[1].replace(/var\([^)]*\)/g, ''))) report('kit.css', n, `raw radius: ${radius[1].trim()}`);
  const size = line.match(/font-size:\s*([^;}]+)/);
  if (size && /\d+px/.test(size[1])) report('kit.css', n, `raw font size: ${size[1].trim()}`);
  const weight = line.match(/font-weight:\s*([^;}]+)/);
  if (weight && /\d/.test(weight[1])) report('kit.css', n, `raw font weight: ${weight[1].trim()}`);
  const z = line.match(/z-index:\s*([^;}]+)/);
  if (z && /^\d/.test(z[1].trim())) report('kit.css', n, `raw z-index: ${z[1].trim()}`);
});

// Every class defined in a stylesheet.
function classesIn(css) {
  const out = new Set();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
  for (const block of noComments.split('{')) {
    const selector = block.split('}').pop();
    for (const m of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}
const kitClasses = classesIn(kit);
const previewCss = fs.readFileSync(path.join(root, 'preview', 'preview.css'), 'utf8');
const previewClasses = classesIn(previewCss);

// ---------------------------------------------------------------- markup
function checkMarkup(file, html, { previewAllowed }) {
  const lines = html.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/).filter(Boolean)) {
        if (c.includes('${')) continue;
        if (kitClasses.has(c)) continue;
        if (previewAllowed && previewClasses.has(c)) continue;
        report(file, n, `class "${c}" is not in kit.css${previewAllowed ? ' or preview.css' : ''}`);
      }
    }
    for (const m of line.matchAll(/style="([^"]*)"/g)) {
      const decls = m[1].split(';').map((d) => d.trim()).filter(Boolean);
      if (decls.some((d) => !d.startsWith('--'))) report(file, n, `inline style: ${m[1]}`);
    }
    if (/<select[\s>]/.test(line)) report(file, n, 'native <select>: use .select');
    if (/border-radius:\s*50%/.test(line)) report(file, n, 'circle: avatars and tiles are rounded squares');
  });
}

const previewDir = path.join(root, 'preview');
for (const f of fs.readdirSync(previewDir).filter((x) => x.endsWith('.html'))) {
  checkMarkup(`preview/${f}`, fs.readFileSync(path.join(previewDir, f), 'utf8'), { previewAllowed: true });
}

// The catalog: each example's markup must be pure kit (no preview classes).
const catalog = loadCatalog();
for (const group of catalog) {
  for (const comp of group.components) {
    for (const ex of comp.examples) checkMarkup(`catalog: ${comp.title} / ${ex.title}`, ex.html, { previewAllowed: false });
  }
}

function loadCatalog() {
  const code = fs.readFileSync(path.join(previewDir, 'catalog.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.KIT_CATALOG;
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`ok: kit.css uses tokens only; ${kitClasses.size} classes; previews and ${catalog.reduce((n, g) => n + g.components.length, 0)} catalog components use only kit classes`);
