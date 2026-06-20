'use strict';

// `astrodock pages …` — publish documents / static bundles / file shares to Pages.
// Uses ASTRODOCK_URL + a pages-scoped ASTRODOCK_TOKEN. Never prints the token.

const fs = require('fs');
const path = require('path');

const BATCH = 20;                                   // max files per upload request
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

// Collect files from a dir (recursively, nested paths preserved) or a single file.
function collect(input) {
  const st = fs.statSync(input);
  if (st.isFile()) return [{ abs: path.resolve(input), rel: path.basename(input) }];
  const root = path.resolve(input);
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || SKIP.has(name)) continue; // dotfiles are rejected server-side anyway
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
    }
  })(root);
  return out;
}

function chunk(arr, n) { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; }

function resolveEntry(flags, names, count) {
  if (flags.entry) return flags.entry;
  if (names.includes('index.html')) return 'index.html';
  if (count === 1) return names[0];
  return names.find((n) => n.endsWith('.html')) || names[0];
}

async function uploadFiles(client, pageId, files) {
  for (const group of chunk(files, BATCH)) {
    const form = new FormData();
    const paths = [];
    for (const f of group) {
      form.append('files', new Blob([fs.readFileSync(f.abs)]), path.basename(f.rel));
      paths.push(f.rel);
    }
    form.append('paths', JSON.stringify(paths));
    const { status, json } = await client.postForm(`/admin/pages/${pageId}/files`, form);
    if (status >= 400) throw new Error(json?.error || `upload failed (${status})`);
  }
}

function settingsFromFlags(flags) {
  const set = {};
  if (flags.title) set.title = flags.title;
  if (flags.access) set.accessMode = flags.access;
  if (flags.data) set.dataMode = flags.data;
  if (flags['generate-passkey']) { set.accessMode = set.accessMode || 'passkey'; set.generatePasskey = true; }
  else if (flags.passkey) { set.accessMode = set.accessMode || 'passkey'; set.passkey = flags.passkey; }
  return set;
}

async function cmdPush(client, positional, flags) {
  const input = positional[0];
  if (!input || !fs.existsSync(input)) throw new Error('usage: astrodock pages push <dir|file> [--title T] [--access public|passkey|platform] [--generate-passkey] [--data shared|per-user] [--page-id ID] [--quiet]');
  const files = collect(input);
  if (!files.length) throw new Error('no files to upload');
  const names = files.map((f) => f.rel);
  const entry = resolveEntry(flags, names, files.length);

  let pageId = flags['page-id'];
  let url, passkey;

  if (!pageId) {
    const body = settingsFromFlags(flags);
    if (!body.title) body.title = path.basename(path.resolve(input));
    const { status, json } = await client.request('POST', '/admin/pages', body);
    if (status >= 400) throw new Error(json?.error || `create failed (${status})`);
    pageId = json.page.pageId; url = json.page.url; passkey = json.page.passkey;
  } else {
    const set = settingsFromFlags(flags);
    if (Object.keys(set).length) {
      const { status, json } = await client.request('PATCH', `/admin/pages/${pageId}`, set);
      if (status >= 400) throw new Error(json?.error || `update failed (${status})`);
      url = json.page.url; passkey = json.page.passkey;
    }
  }

  await uploadFiles(client, pageId, files);

  if (entry && entry !== 'index.html' && names.includes(entry)) {
    const { status, json } = await client.request('PATCH', `/admin/pages/${pageId}`, { entryFile: entry });
    if (status >= 400) throw new Error(json?.error || `set entry failed (${status})`);
  }

  if (!url) { // updating an existing page without a settings change — fetch for the link
    const { json } = await client.request('GET', `/admin/pages/${pageId}`);
    if (json?.page) { url = json.page.url; passkey = passkey ?? json.page.passkey; }
  }

  if (flags.quiet) { console.log(url); return; }
  console.log(`Published ${files.length} file${files.length > 1 ? 's' : ''} to page "${pageId}".`);
  console.log(`  URL:     ${url}`);
  if (passkey) console.log(`  passkey: ${passkey}   (frictionless link: ${url}?key=${encodeURIComponent(passkey)})`);
  console.log(`  update:  astrodock pages push ${input} --page-id ${pageId}`);
}

async function cmdList(client) {
  const { status, json } = await client.request('GET', '/admin/pages');
  if (status >= 400) throw new Error(json?.error || `list failed (${status})`);
  if (!json.pages.length) { console.log('(no pages)'); return; }
  for (const p of json.pages) {
    console.log(`${p.pageId}  ${(p.title || '').slice(0, 28).padEnd(28)} ${p.accessMode.padEnd(8)} data:${(p.dataMode || 'none').padEnd(8)} ${p.isActive ? 'active  ' : 'inactive'} views:${p.views}`);
  }
}

async function cmdRm(client, positional) {
  const id = positional[0];
  if (!id) throw new Error('usage: astrodock pages rm <pageId>');
  const { status, json } = await client.request('DELETE', `/admin/pages/${id}`);
  if (status >= 400) throw new Error(json?.error || `delete failed (${status})`);
  console.log(`Deleted page ${id}.`);
}

async function cmdPages(client, positional, flags) {
  const sub = positional[0];
  const rest = positional.slice(1);
  switch (sub) {
    case 'push': return cmdPush(client, rest, flags);
    case 'list': return cmdList(client);
    case 'rm': case 'delete': return cmdRm(client, rest);
    default: throw new Error('usage: astrodock pages <push|list|rm> …');
  }
}

module.exports = { cmdPages, collect, resolveEntry, chunk };
