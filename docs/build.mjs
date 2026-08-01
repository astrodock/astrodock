// Build the docs site.
//
// There is nothing to compile. The docs are hand-written HTML with relative
// links and one stylesheet, which is why they have always worked from a GitHub
// Pages subpath and will work unchanged at docs.<your-domain>. The only reason
// this file exists is that the Node buildpack publishes whatever is in dist/,
// so the "build" is a copy into that directory.
//
// No dependencies on purpose: npm install here should do nothing and take no
// time, and a docs site should not be able to break a deploy by resolving a
// package differently than it did last week.

import { cp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

// Everything that is part of the published site. Anything not named here — the
// markdown sources, this script, package.json, app.json — deliberately stays
// out of the deployed directory.
const ASSET_DIRS = ['assets'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const entries = await readdir(here, { withFileTypes: true });
const pages = entries
  .filter((e) => e.isFile() && e.name.endsWith('.html'))
  .map((e) => e.name)
  .sort();

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

// The buildpack serves this directory with `try_files {path} /index.html`, which
// turns any unknown URL into the front page rather than a 404. For a docs site
// that is the wrong answer — a stale link should say it is broken, not silently
// show you the homepage and let you think you arrived. A 404.html does not
// change Caddy's fallback on its own, but it is what a static host expects to
// find, and it keeps the file here for when routing learns to use it.
if (!pages.includes('404.html')) {
  await writeFile(join(out, '404.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page not found — Astrodock docs</title>
  <link rel="stylesheet" href="assets/styles.css">
</head>
<body>
  <main style="max-width:36rem;margin:6rem auto;padding:0 1.5rem">
    <h1>That page isn't here</h1>
    <p>The link may be out of date, or the page may have been renamed.</p>
    <p><a href="index.html">Go to the documentation home</a></p>
  </main>
</body>
</html>
`);
}

console.log(`docs: ${pages.length} pages → dist/`);
