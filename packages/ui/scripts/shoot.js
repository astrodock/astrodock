#!/usr/bin/env node
'use strict';

// Screenshots of the preview pages, for checking a change by eye.
//   node scripts/shoot.js <out-dir> [page,page,...] [--dark] [--phone] [--full]
// Pages are preview file names without .html (default: all of them).
// Needs playwright-core: installed in this package, or its path in PLAYWRIGHT_CORE.
// Also prints any script errors the pages throw.

const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core')); } catch {
  console.error('playwright-core not found. Install it, or set PLAYWRIGHT_CORE to its path.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [out, only] = args.filter((a) => !a.startsWith('--'));
if (!out) { console.error('Usage: node scripts/shoot.js <out-dir> [page,page] [--dark] [--phone] [--full]'); process.exit(1); }

const dir = path.join(__dirname, '..', 'preview');
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
const pages = only ? only.split(',') : all;
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const viewport = flags.has('--phone') ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const page = await (await browser.newContext({ viewport })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url().split('/').pop()}: ${e.message}`));
  for (const name of pages) {
    await page.goto('file://' + path.join(dir, `${name}.html`));
    if (flags.has('--dark')) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(500);
    const suffix = (flags.has('--dark') ? '-dark' : '') + (flags.has('--phone') ? '-phone' : '');
    await page.screenshot({ path: path.join(out, `${name}${suffix}.png`), fullPage: flags.has('--full') });
  }
  console.log(errors.length ? errors.join('\n') : 'No script errors');
  await browser.close();
})();
