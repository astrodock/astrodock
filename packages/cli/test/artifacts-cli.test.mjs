// `astrodock artifacts …` against the real control plane in-process, with the
// object store in memory, and a stand-in hosted service for `artifacts login`
// that seals a key the way the real one does.
//
//   ASTRODOCK_PG_HOST=… ASTRODOCK_PG_DATABASE=… node packages/cli/test/artifacts-cli.test.mjs
//
// It empties the artifact tables, keys and users of the database it points at.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const cpDir = path.join(repoRoot, 'apps/control-plane');
const require = createRequire(path.join(cpDir, 'server.js'));

process.env.ASTRODOCK_BASE_DOMAIN = 'localhost';
process.env.ASTRODOCK_TLS_MODE = 'off';
process.env.ASTRODOCK_ENV = 'development';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'cli-artifacts-jwt';
process.env.ASTRODOCK_UPSTREAM_FEEDBACK_URL = '';
process.env.ASTRODOCK_ADMIN_EMAIL = 'admin@example.com';
process.env.ASTRODOCK_ADMIN_PASSWORD = 'test-admin-password';

const objects = new Map();
const store = require(path.join(cpDir, 'src/lib/pages-store.js'));
store.putFile = async (id, name, body) => { objects.set(`${id}/${name}`, Buffer.from(body)); };
store.getFile = async (id, name) => (objects.has(`${id}/${name}`) ? { body: objects.get(`${id}/${name}`) } : null);
store.deleteFile = async () => {};
store.deleteAll = async () => {};

const { app } = require(path.join(cpDir, 'server.js'));
const { migrate } = require(path.join(cpDir, 'src/db/migrate.js'));
const { seedAdmin } = require(path.join(cpDir, 'src/seed.js'));
const { db, schema, close } = require(path.join(cpDir, 'src/db/index.js'));
const sealed = require(path.join(cpDir, 'src/lib/sealed.js'));
const ids = require(path.join(cpDir, 'src/lib/ids.js'));
const { eq } = require('drizzle-orm');

const BIN = path.join(repoRoot, 'packages/cli/bin/astrodock.js');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); failed++; }
}

await migrate({ log: () => {} });
for (const t of [schema.artifactFeedback, schema.artifactErrors, schema.artifactShares, schema.artifactFiles, schema.artifacts, schema.apiTokens, schema.sessions, schema.users]) await db.delete(t);
await seedAdmin({ log: () => {} });
const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, 'admin@example.com'));

const cp = app.listen(0);
await new Promise((r) => cp.once('listening', r));
const cpUrl = `http://127.0.0.1:${cp.address().port}`;

// A stand-in hosted service: start returns the check code; the first poll is
// approved with a real key on the control plane, sealed to the CLI.
const logins = new Map();
const cloud = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const b = body ? JSON.parse(body) : {};
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url === '/api/artifacts-login/start') {
      const deviceCode = `dc_${crypto.randomBytes(8).toString('hex')}`;
      logins.set(deviceCode, b);
      return send(201, { deviceCode, userCode: 'BCDF-GHJK', checkCode: sealed.checkCode(b.codeChallenge, b.clientPublicKey), verificationUriComplete: 'http://cloud.test/connect/BCDF-GHJK', interval: 2, expiresIn: 60 });
    }
    if (req.url === '/api/artifacts-login/poll') {
      const l = logins.get(b.deviceCode);
      if (!l || crypto.createHash('sha256').update(b.codeVerifier).digest('base64url') !== l.codeChallenge) return send(400, { status: 'invalid_verifier' });
      const raw = ids.generateApiToken();
      await db.insert(schema.apiTokens).values({ name: 'agent: test', tokenHash: ids.hashToken(raw), scopes: ['artifacts:read', 'artifacts:write'], authorizedByUserId: admin.id });
      return send(200, { status: 'approved', sealed: sealed.seal(JSON.stringify({ token: raw, url: cpUrl }), l.clientPublicKey, l.codeChallenge) });
    }
    send(404, {});
  });
});
cloud.listen(0);
await new Promise((r) => cloud.once('listening', r));
const cloudUrl = `http://127.0.0.1:${cloud.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adock-art-'));
const env = { ...process.env, ASTRODOCK_CLOUD_URL: cloudUrl };
delete env.ASTRODOCK_URL; delete env.ASTRODOCK_TOKEN;
const run = (...args) => pexec('node', [BIN, 'artifacts', ...args], { cwd: dir, env, timeout: 30000 });

try {
  console.log('astrodock artifacts');

  await test('login connects through the hosted service and saves a key', async () => {
    const { stdout } = await run('login', '--email', 'person@example.com', '--no-browser');
    assert.match(stdout, /Give person@example\.com this link: http:\/\/cloud\.test\/connect\/BCDF-GHJK/);
    assert.match(stdout, /Connected\. The key reaches artifacts only/);
    const saved = fs.readFileSync(path.join(dir, '.env.astrodock'), 'utf8');
    assert.match(saved, new RegExp(`ASTRODOCK_URL=${cpUrl.replace(/\./g, '\\.')}`));
    assert.match(saved, /ASTRODOCK_TOKEN=tk_/);
    assert.strictEqual((fs.statSync(path.join(dir, '.env.astrodock')).mode & 0o777), 0o600);
  });

  let id;
  await test('create with files and a manifest, then list', async () => {
    fs.mkdirSync(path.join(dir, 'site/js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'site/index.html'), '<html><head></head><body>Board</body></html>');
    fs.writeFileSync(path.join(dir, 'site/js/app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'site/.secret'), 'no');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ collections: { posts: { fields: { text: 'string' } } } }));
    const { stdout } = await run('create', 'Team Board', '--dir', 'site', '--manifest', 'manifest.json');
    assert.match(stdout, /Uploaded 2 files\./, 'dotfiles are left out');
    id = /^([a-z0-9]{12}) /m.exec(stdout)[1];
    const list = (await run('list')).stdout;
    assert.match(list, new RegExp(`${id}\\s+owner\\s+Team Board`));
    const [a] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.publicId, id));
    assert.deepStrictEqual(Object.keys(a.manifest.collections), ['posts']);
    assert.ok(objects.has(`artifacts/${id}/js/app.js`), 'nested paths kept');
  });

  await test('manifest problems are printed with their paths', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ roles: ['boss'] }));
    await assert.rejects(run('manifest', id, 'bad.json'), (e) => /roles\[0\]: the first \(highest\) role must be "owner"/.test(e.stderr));
    const printed = (await run('manifest', id)).stdout;
    assert.deepStrictEqual(Object.keys(JSON.parse(printed).collections), ['posts']);
  });

  await test('share, unshare, errors, usage, feedback, guide', async () => {
    const s = (await run('share', id, 'a@example.com', 'b@example.com', '--role', 'viewer', '--no-notify')).stdout;
    assert.match(s, /a@example\.com\s+viewer\s+added \(invite not_sent\)/);
    assert.match((await run('unshare', id, 'b@example.com')).stdout, /no longer has access/);
    assert.match((await run('errors', id)).stdout, /No errors\./);
    assert.match((await run('usage', id)).stdout, /Views 0, people 0/);
    assert.match((await run('feedback', 'Two-field rules', '--tried', 'field rules', '--artifact', id)).stdout, /Sent \(none\)\./);
    assert.match((await run('guide')).stdout, /# Building Artifacts on Astrodock/);
    await assert.rejects(run('nope'), (e) => /unknown artifacts command "nope"/.test(e.stderr));
  });
} finally {
  cp.close();
  cloud.close();
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
