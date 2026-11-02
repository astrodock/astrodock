'use strict';

// Shared fixtures: provider keys, fake APNs and FCM servers, and a relay
// started in-process on port 0. Everything here closes at the end of a test
// file; nothing outside the test process is started.

const crypto = require('node:crypto');
const http = require('node:http');
const http2 = require('node:http2');
const { loadConfig } = require('../src/config');
const { createRelay } = require('../src/app');
const { createMemoryStore } = require('../src/store/memory');

function apnsKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

function serviceAccountKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

function decodeJwt(token) {
  const [h, c, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url')),
    claims: JSON.parse(Buffer.from(c, 'base64url')),
    input: `${h}.${c}`,
    signature: Buffer.from(s, 'base64url')
  };
}

// Plain-text HTTP/2 (h2c): the relay talks h2c when RELAY_APNS_HOST is an
// http:// origin, which only tests do. `responses` maps a device token to the
// { status, reason } the fake answers with; the default is 200.
async function startFakeApns() {
  const requests = [];
  const responses = new Map();
  let sessions = 0;
  const server = http2.createServer();
  server.on('session', () => { sessions += 1; });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { body += c; });
    stream.on('end', () => {
      const deviceToken = headers[':path'].replace('/3/device/', '');
      requests.push({ headers, body: JSON.parse(body), deviceToken });
      const r = responses.get(deviceToken) || { status: 200 };
      stream.respond({ ':status': r.status, 'content-type': 'application/json' });
      stream.end(r.reason ? JSON.stringify({ reason: r.reason }) : '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    responses,
    get sessions() { return sessions; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// One HTTP server for both Google endpoints. `responses` maps a device token
// to { status, body } for the send call; the default is 200.
async function startFakeFcm(publicKey) {
  const tokenRequests = [];
  const sends = [];
  const responses = new Map();
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/token') {
        const form = new URLSearchParams(text);
        const jwt = decodeJwt(form.get('assertion'));
        const valid = crypto.verify('sha256', Buffer.from(jwt.input), publicKey, jwt.signature);
        tokenRequests.push({ grantType: form.get('grant_type'), jwt, valid });
        if (!valid) return reply(400, { error: 'invalid_grant' });
        return reply(200, { access_token: 'ya29.test-access-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (req.url === '/v1/projects/test-project/messages:send') {
        const body = JSON.parse(text);
        sends.push({ authorization: req.headers.authorization, body });
        if (req.headers.authorization !== 'Bearer ya29.test-access-token') return reply(401, { error: { status: 'UNAUTHENTICATED' } });
        const r = responses.get(body.message.token);
        if (r) return reply(r.status, r.body);
        return reply(200, { name: 'projects/test-project/messages/1' });
      }
      reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    tokenUrl: `${origin}/token`,
    sendUrl: `${origin}/v1/projects/test-project/messages:send`,
    tokenRequests,
    sends,
    responses,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
}

// Starts a relay over the in-memory store. `env` is read through loadConfig,
// the same path production uses.
async function startRelay({ env = {}, limits } = {}) {
  const lines = [];
  const config = loadConfig(env, (msg) => lines.push(`warn ${msg}`));
  const store = createMemoryStore();
  const relay = createRelay({ config, store, limits, log: (line) => lines.push(line) });
  const { port } = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  return { relay, store, config, lines, base, port, call, close: () => relay.close() };
}

// A well-formed envelope. The relay checks only its shape.
function envelope() {
  return {
    v: 1,
    e: crypto.randomBytes(32).toString('base64'),
    n: crypto.randomBytes(12).toString('base64'),
    c: crypto.randomBytes(48).toString('base64')
  };
}

const iosToken = () => crypto.randomBytes(32).toString('hex');
const androidToken = () => `${crypto.randomBytes(11).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;

module.exports = {
  apnsKeyPair, serviceAccountKeyPair, decodeJwt,
  startFakeApns, startFakeFcm, startRelay,
  envelope, iosToken, androidToken
};
