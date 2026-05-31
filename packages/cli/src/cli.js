'use strict';

const fs = require('fs');
const path = require('path');
const { validate } = require('@toolstead/schema');
const { makeClient } = require('./client');

const USAGE = `toolstead — drive a Toolstead platform from an app repo

Usage:
  toolstead <command> [options]

Commands:
  apply [--file app.json] [--prune]   Create/update the app from app.json, connect repo, provision
  deploy [slug]                        Trigger a deploy (slug defaults to app.json's slug)
  deploy:watch [slug] [--id <id>]      Trigger (or attach to) a deploy and stream its log until done
  status [slug]                        Show the app's process status
  logs [slug] [--lines N]              Print recent app logs
  set-secret <KEY> [value] [slug]      Set an env var value (value read from stdin if omitted)
  apps                                 List apps
  help                                 Show this help

Environment:
  TOOLSTEAD_URL     Base URL of the admin host, e.g. https://admin.example.com
  TOOLSTEAD_TOKEN   A scoped API token (tk_...) or an admin JWT

app.json is read from the current directory (or --file). Secret VALUES never go in app.json.`;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function readManifest(file) {
  const p = path.resolve(file || 'app.json');
  if (!fs.existsSync(p)) throw new Error(`app.json not found at ${p}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`app.json is not valid JSON: ${e.message}`); }
  const { valid, errors } = validate(manifest);
  if (!valid) throw new Error(`app.json failed validation:\n  - ${errors.join('\n  - ')}`);
  return manifest;
}

function slugFromArgsOrManifest(positional, flags) {
  if (positional[0]) return positional[0];
  try { return readManifest(flags.file).slug; } catch { return null; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }

async function cmdApply(client, flags) {
  const manifest = readManifest(flags.file);
  const { status, json } = await client.request('POST', '/admin/apps/apply', { manifest, prune: !!flags.prune });
  if (status >= 400) {
    if (json?.errors) die(`${json.error}\n  - ${json.errors.join('\n  - ')}`);
    die(json?.error || `apply failed (${status})`);
  }
  console.log(`${json.created ? 'Created' : 'Updated'} "${manifest.slug}" (${manifest.subdomain}.<domain>)`);
  if (json.appSecret) console.log(`  app secret (shown once): ${json.appSecret}`);
  if (json.repoConnected) console.log('  repo connected (webhook created)');
  if (json.repoError) console.log(`  repo connect skipped: ${json.repoError}`);
  for (const r of json.provision || []) console.log(`  · ${r}`);
}

async function cmdDeploy(client, positional, flags) {
  const slug = slugFromArgsOrManifest(positional, flags);
  if (!slug) die('no slug (pass one or run from an app.json directory)');
  const { status, json } = await client.request('POST', `/admin/apps/${slug}/deploy`);
  if (status === 422 && json?.missing) {
    console.error(`Deploy blocked — set these first (toolstead set-secret KEY):`);
    for (const m of json.missing) console.error(`  - ${m.key} (${m.reason})`);
    process.exit(2);
  }
  if (status >= 400) die(json?.error || `deploy failed (${status})`);
  console.log(`Deploy triggered for "${slug}" (deployment ${json.deploymentId})`);
  return json.deploymentId;
}

async function pollDeploy(client, slug, id) {
  let lastLen = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { status, json } = await client.request('GET', `/admin/apps/${slug}/deployments/${id}`);
    if (status >= 400) die(json?.error || `cannot read deployment (${status})`);
    const d = json.deployment;
    const log = d.log || '';
    if (log.length > lastLen) { process.stdout.write(log.slice(lastLen)); lastLen = log.length; }
    if (d.status === 'success') { console.log(`\n✓ deploy ${d.status} (${d.commitHash || ''})`); return 0; }
    if (d.status === 'failed') { console.error(`\n✗ deploy failed: ${d.error || 'see log'}`); return 1; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function cmdDeployWatch(client, positional, flags) {
  const slug = slugFromArgsOrManifest(positional, flags);
  if (!slug) die('no slug (pass one or run from an app.json directory)');
  let id = flags.id;
  if (!id) id = await cmdDeploy(client, [slug], flags);
  if (!id) process.exit(1);
  const code = await pollDeploy(client, slug, id);
  process.exit(code);
}

async function cmdStatus(client, positional, flags) {
  const slug = slugFromArgsOrManifest(positional, flags);
  if (!slug) die('no slug');
  const { status, json } = await client.request('GET', `/admin/apps/${slug}/status`);
  if (status >= 400) die(json?.error || `status failed (${status})`);
  console.log(JSON.stringify(json, null, 2));
}

async function cmdLogs(client, positional, flags) {
  const slug = slugFromArgsOrManifest(positional, flags);
  if (!slug) die('no slug');
  const lines = flags.lines || 100;
  const { status, json } = await client.request('GET', `/admin/apps/${slug}/logs?lines=${lines}`);
  if (status >= 400) die(json?.error || `logs failed (${status})`);
  console.log(json.logs || '(no logs)');
}

async function cmdSetSecret(client, positional) {
  const key = positional[0];
  if (!key) die('usage: toolstead set-secret <KEY> [value] [slug]');
  let value = positional[1];
  let slug = positional[2];
  if (value === undefined) value = await readStdin();
  if (!value) die('no value provided (pass as an argument or pipe via stdin)');
  if (!slug) slug = slugFromArgsOrManifest([], {});
  if (!slug) die('no slug (pass as the 3rd argument or run from an app.json directory)');
  const { status, json } = await client.request('PUT', `/admin/apps/${slug}/env/${key}`, { value });
  if (status >= 400) die(json?.error || `set-secret failed (${status})`);
  console.log(`Set ${key} for "${slug}".`);
}

async function cmdApps(client) {
  const { status, json } = await client.request('GET', '/admin/apps');
  if (status >= 400) die(json?.error || `list failed (${status})`);
  for (const a of json.apps) {
    console.log(`${a.slug.padEnd(20)} ${a.subdomain.padEnd(16)} ${a.runtime.type.padEnd(7)} db:${a.database.mode} storage:${a.storage.mode} ${a.provisioned ? 'provisioned' : 'unprovisioned'}`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  if (!command || command === 'help' || flags.help) { console.log(USAGE); return; }

  let client;
  try { client = makeClient(); }
  catch (e) { die(e.message); }

  try {
    switch (command) {
      case 'apply': return await cmdApply(client, flags);
      case 'deploy': { await cmdDeploy(client, positional, flags); return; }
      case 'deploy:watch': return await cmdDeployWatch(client, positional, flags);
      case 'status': return await cmdStatus(client, positional, flags);
      case 'logs': return await cmdLogs(client, positional, flags);
      case 'set-secret': return await cmdSetSecret(client, positional);
      case 'apps': return await cmdApps(client);
      default: die(`unknown command "${command}" (try: toolstead help)`);
    }
  } catch (e) {
    die(e.message);
  }
}

module.exports = { main, parseFlags, readManifest };
