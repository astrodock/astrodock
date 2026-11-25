'use strict';

// `astrodock artifacts …`: build artifacts (small apps with their own data,
// shared by email) from the command line.
//
// `artifacts login --email you@example.com` connects through the hosted
// service: it prints a link, the person presses Send Code there and types the
// code, and the key comes back sealed to this process. The key reaches
// artifacts only. On a self-hosted instance, `astrodock login` gives a key
// that covers artifacts too, and these commands work with it.

const fs = require('node:fs');
const path = require('node:path');
const { CRED_FILE } = require('./credentials');
const { pkce, keyPair, openSealed, checkCode, ensureIgnored, writeCredentials, DEFAULT_CLOUD_URL } = require('./login');
const { openUrl } = require('./browser');

const BATCH = 20;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'private']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpsOnly(url, label) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label} is not a valid URL: ${url}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`${label} must use https`);
  return url.replace(/\/$/, '');
}

async function postJson(url, body) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (err) { throw new Error(`Cannot reach ${new URL(url).origin}: ${err.message}`); }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(flags, { cwd = process.cwd(), log = console.log } = {}) {
  const email = flags.email;
  if (!email || email === true) throw new Error('usage: astrodock artifacts login --email person@example.com [--name "Claude Code"]');
  const cloud = httpsOnly(String(flags.cloud || process.env.ASTRODOCK_CLOUD_URL || DEFAULT_CLOUD_URL), 'The Astrodock cloud URL');
  const { verifier, challenge } = pkce();
  const keys = keyPair();
  const check = checkCode(challenge, keys.publicKey);
  const name = typeof flags.name === 'string' ? flags.name : `astrodock CLI on ${require('node:os').hostname()}`;
  const start = await postJson(`${cloud}/api/artifacts-login/start`, { email, codeChallenge: challenge, clientPublicKey: keys.publicKey, client: { name, folder: path.basename(cwd), cliVersion: require('../package.json').version } });
  if (start.status >= 400) throw new Error(start.json.error || `Could not start (${start.status}).`);
  if (start.json.checkCode !== check) throw new Error('The service returned a different check code. Stopped.');
  log('');
  log(`Give ${email} this link: ${start.json.verificationUriComplete}`);
  log(`They press Send Code there and type the code they get. The page shows this check code: ${check}`);
  if (!flags['no-browser'] && openUrl(start.json.verificationUriComplete)) log('Opened it in your browser.');
  log('Waiting…');

  let wait = Math.max(Number(start.json.interval) || 3, 2) * 1000;
  const until = Date.now() + (Number(start.json.expiresIn) || 1800) * 1000;
  let got;
  while (!got) {
    if (Date.now() > until) throw new Error('The link expired. Run this again.');
    await sleep(wait);
    const r = await postJson(`${cloud}/api/artifacts-login/poll`, { deviceCode: start.json.deviceCode, codeVerifier: verifier });
    if (r.status === 429) { wait += 2000; continue; }
    if (r.json.status === 'pending') continue;
    if (r.json.status === 'approved') { got = r.json; break; }
    if (r.json.status === 'denied') throw new Error('They declined.');
    throw new Error(r.json.error || `The sign-in ended (${r.json.status || r.status}).`);
  }
  let opened;
  try { opened = JSON.parse(openSealed(got.sealed, keys.privateKey, challenge)); }
  catch { throw new Error('The key could not be opened, so it was not meant for this sign-in.'); }
  if (!/^tk_[A-Za-z0-9_-]+$/.test(String(opened.token))) throw new Error('What came back is not an access key.');
  const url = httpsOnly(String(opened.url), 'The artifacts URL');
  const file = writeCredentials(cwd, url, opened.token);
  const ignored = ensureIgnored(cwd);
  log('');
  log(`Connected. The key reaches artifacts only. Saved to ${path.relative(cwd, file) || CRED_FILE}${ignored ? ' (and added to .gitignore)' : ''}.`);
  log('Next: astrodock artifacts guide');
}

function collect(input) {
  const st = fs.statSync(input);
  if (st.isFile()) return [{ abs: path.resolve(input), rel: path.basename(input) }];
  const root = path.resolve(input);
  const out = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('.') || SKIP.has(n)) continue;
      const abs = path.join(dir, n);
      const l = fs.lstatSync(abs);
      if (l.isSymbolicLink()) continue;
      if (l.isDirectory()) walk(abs);
      else if (l.isFile()) out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
    }
  })(root);
  return out;
}

async function uploadDir(client, id, input) {
  const files = collect(input);
  if (!files.length) throw new Error('No files to upload.');
  for (let i = 0; i < files.length; i += BATCH) {
    const group = files.slice(i, i + BATCH);
    const form = new FormData();
    for (const f of group) form.append('files', new Blob([fs.readFileSync(f.abs)]), path.basename(f.rel));
    form.append('paths', JSON.stringify(group.map((f) => f.rel)));
    const { status, json } = await client.postForm(`/admin/artifacts/${id}/files`, form);
    if (status >= 400) throw new Error(json?.error || `Upload failed (${status}).`);
  }
  return files.length;
}

function must({ status, json }) {
  if (status >= 400) {
    const extra = json && json.problems ? `\n${json.problems.map((p) => `  ${typeof p === 'string' ? p : `${p.path}: ${p.message}`}`).join('\n')}` : '';
    throw new Error(`${(json && json.error) || `Failed (${status})`}${extra}`);
  }
  return json;
}

const USAGE = `astrodock artifacts <sub>
  login --email E [--name N]          Connect through the hosted service (key for artifacts only)
  guide                               Print the guide: manifest, rules, client, actions, limits
  list                                Your artifacts
  create "<title>" [--dir D] [--manifest F]   Make one; upload D and set the manifest from F
  push <id> <dir|file>                Upload files (replaces files of the same name)
  manifest <id> [file.json]           Print the manifest, or set it from a file
  share <id> <email>… [--role R] [--no-notify]
  unshare <id> <email>
  errors <id> [--clear]               Errors from the page and failed data calls
  usage <id>                          Views, people, writes, storage, emails
  feedback "<needed>" [--tried T] [--workaround W] [--artifact ID]
                                      Something the framework cannot do. Goes to the Astrodock project.`;

async function cmdArtifacts(makeClient, positional, flags, { log = console.log } = {}) {
  const [sub, ...rest] = positional;
  if (!sub || sub === 'help') { log(USAGE); return; }
  if (sub === 'login') return login(flags, { log });
  const client = makeClient();
  switch (sub) {
    case 'guide': {
      const r = await client.request('GET', '/admin/artifacts/guide');
      if (r.status >= 400) must(r);
      log(r.json && r.json.raw ? r.json.raw : String(r.json || ''));
      return;
    }
    case 'list': {
      const { artifacts } = must(await client.request('GET', '/admin/artifacts'));
      if (!artifacts.length) { log('No artifacts yet.'); return; }
      for (const a of artifacts) log(`${a.id}  ${a.access.padEnd(8)}  ${a.title}  ${a.url}`);
      return;
    }
    case 'create': {
      const title = rest[0];
      if (!title) throw new Error('usage: astrodock artifacts create "<title>" [--dir D] [--manifest F]');
      const body = { title };
      if (flags.manifest) body.manifest = JSON.parse(fs.readFileSync(flags.manifest, 'utf8'));
      const { artifact } = must(await client.request('POST', '/admin/artifacts', body));
      if (flags.dir) log(`Uploaded ${await uploadDir(client, artifact.id, flags.dir)} files.`);
      log(`${artifact.id}  ${artifact.url}`);
      return;
    }
    case 'push': {
      const [id, input] = rest;
      if (!id || !input || !fs.existsSync(input)) throw new Error('usage: astrodock artifacts push <id> <dir|file>');
      log(`Uploaded ${await uploadDir(client, id, input)} files.`);
      return;
    }
    case 'manifest': {
      const [id, file] = rest;
      if (!id) throw new Error('usage: astrodock artifacts manifest <id> [file.json]');
      if (!file) { log(JSON.stringify(must(await client.request('GET', `/admin/artifacts/${id}`)).artifact.manifest, null, 2)); return; }
      const r = must(await client.request('PATCH', `/admin/artifacts/${id}`, { manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }));
      log('Manifest saved.');
      for (const w of r.warnings || []) log(`Note: ${w}`);
      return;
    }
    case 'share': {
      const [id, ...emails] = rest;
      if (!id || !emails.length) throw new Error('usage: astrodock artifacts share <id> <email>… [--role R] [--no-notify]');
      const r = must(await client.request('POST', `/admin/artifacts/${id}/shares`, { emails, role: typeof flags.role === 'string' ? flags.role : undefined, notify: !flags['no-notify'] }));
      for (const x of r.results) log(`${x.email}  ${x.role}  ${x.status}${x.invite ? ` (invite ${x.invite})` : ''}`);
      return;
    }
    case 'unshare': {
      const [id, email] = rest;
      if (!id || !email) throw new Error('usage: astrodock artifacts unshare <id> <email>');
      must(await client.request('DELETE', `/admin/artifacts/${id}/shares?email=${encodeURIComponent(email)}`));
      log(`${email} no longer has access.`);
      return;
    }
    case 'errors': {
      const [id] = rest;
      if (!id) throw new Error('usage: astrodock artifacts errors <id> [--clear]');
      if (flags.clear) { must(await client.request('DELETE', `/admin/artifacts/${id}/errors`)); log('Cleared.'); return; }
      const { errors } = must(await client.request('GET', `/admin/artifacts/${id}/errors`));
      if (!errors.length) { log('No errors.'); return; }
      for (const e of errors) {
        log(`${e.kind}  ×${e.count}  ${e.message}${e.source ? `  (${e.source})` : ''}${e.path ? `  on ${e.path}` : ''}`);
        if (e.stack) log(e.stack.split('\n').slice(0, 4).map((l) => `    ${l}`).join('\n'));
      }
      return;
    }
    case 'usage': {
      const [id] = rest;
      if (!id) throw new Error('usage: astrodock artifacts usage <id>');
      const { usage, people } = must(await client.request('GET', `/admin/artifacts/${id}/usage`));
      log(`Views ${usage.views30}, people ${usage.people30}, changes ${usage.writes30}, reads ${usage.reads30} (30 days)`);
      log(`Records ${usage.records}, storage ${usage.storageBytes} bytes, emails ${usage.emails30}, errors ${usage.errors7} (7 days)`);
      for (const p of people) log(`  ${p.email}  ${p.role || 'no longer shared'}  last seen ${p.lastSeen || 'never'}`);
      return;
    }
    case 'feedback': {
      const needed = rest[0];
      if (!needed) throw new Error('usage: astrodock artifacts feedback "<needed>" [--tried T] [--workaround W] [--artifact ID]');
      const r = must(await client.request('POST', '/admin/artifacts/feedback', { needed, tried: flags.tried, workaround: flags.workaround, artifactId: flags.artifact }));
      log(`Sent (${r.feedback.upstreamStatus}).`);
      return;
    }
    default:
      throw new Error(`unknown artifacts command "${sub}"\n${USAGE}`);
  }
}

module.exports = { cmdArtifacts, collect, USAGE };
