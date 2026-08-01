// Build the marketing site.
//
// Same shape as docs/build.mjs and for the same reason: there is nothing to
// compile, but the Node buildpack publishes whatever is in dist/, so the build
// is a copy into that directory. No dependencies — npm install here should do
// nothing, take no time, and never be the reason a deploy fails.

import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

const ASSET_DIRS = ['assets'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const entries = await readdir(here, { withFileTypes: true });
const pages = entries
  .filter((e) => e.isFile() && e.name.endsWith('.html'))
  .map((e) => e.name)
  .sort();

// Both of these would otherwise deploy successfully and serve a broken site,
// which is the worst shape a failure can take: green everywhere, wrong in the
// one place anybody looks.
if (pages.length === 0) {
  console.error('No .html files found — refusing to publish an empty site.');
  process.exit(1);
}
if (!pages.includes('index.html')) {
  console.error('No index.html — the site would have no front door.');
  process.exit(1);
}

for (const name of pages) {
  await cp(join(here, name), join(out, name));
}

for (const dir of ASSET_DIRS) {
  if (existsSync(join(here, dir))) {
    await cp(join(here, dir), join(out, dir), { recursive: true });
  }
}

console.log(`site: ${pages.length} page${pages.length === 1 ? '' : 's'} → dist/`);
