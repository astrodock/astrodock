// Adapt the generated Caddyfile with a real Caddy.
//
// String assertions cannot tell you whether Caddy will accept the config. The
// static-404 work put handle_errors inside handle{} — which reads fine, matches
// the docs' snippet, and is rejected at adapt time with "not an ordered HTTP
// handler". Every site block would have failed to load. Only running the adapter
// catches that class of mistake.
//
// Skips cleanly where Docker is unavailable, so it never blocks a working tree.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../src/config');
const { generateCaddyfile } = require('../src/provision/caddy.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

function haveDocker() {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

console.log('\ncaddyfile adapts under a real caddy');

if (!haveDocker()) {
  console.log('  -- skipped: docker unavailable');
} else {
  const APPS = [
    { slug: 'sitedocs', subdomain: 'sitedocs', runtimeType: 'node', port: 3101, spa: false, provisioned: true },
    { slug: 'spaapp', subdomain: 'spaapp', runtimeType: 'node', port: 3102, spa: true, provisioned: true },
    { slug: 'boxed', subdomain: 'boxed', runtimeType: 'docker', port: 3103, provisioned: true }
  ];

  const cases = [
    ['a plain fleet', APPS, {}],
    ['with an apex and www', APPS, { apexApp: 'sitedocs' }],
    ['with a static app at the apex', APPS, { apexApp: 'sitedocs', apexWww: false }],
    ['with redirects', APPS, { redirects: 'get https://example.org/install.sh\n# note\nold https://example.org/' }],
    ['with a custom domain', APPS, {
      domains: [{ hostname: 'example.net', appSlug: 'sitedocs', runtimeType: 'node', port: 3101, spa: false, isPrimary: true }]
    }],
    ['with access logs on', APPS, { accessLogs: true, apexApp: 'spaapp' }]
  ];

  for (const mode of ['auto', 'off', 'internal']) {
    const saved = config.tlsMode;
    config.applyRuntimeDomain({ tlsMode: mode });
    for (const [label, apps, opts] of cases) {
      test(`${label} (tls=${mode})`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
        const file = path.join(dir, 'Caddyfile');
        fs.writeFileSync(file, generateCaddyfile(apps, opts));
        try {
          execFileSync('docker', ['run', '--rm', '-v', `${file}:/etc/caddy/Caddyfile:ro`,
            'caddy:2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile',
            '--adapter', 'caddyfile'], { stdio: 'pipe' });
        } catch (e) {
          throw new Error(String(e.stderr || e.stdout || e.message).split('\n').filter((l) => l.includes('Error')).join(' ') || e.message);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
    config.applyRuntimeDomain({ tlsMode: saved });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
