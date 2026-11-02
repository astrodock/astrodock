'use strict';

// The relay's HTTP API end to end, over the in-memory store, against fake
// APNs (HTTP/2) and FCM (HTTP/1) servers running in this process.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const h = require('./helpers');

const KEY_ID = 'ABC123DEFG';
const TEAM_ID = 'TEAM123456';
const TOPIC = 'ai.astrodock.mobile';

let apnsKey, saKey, fakeApns, fakeFcm, relay;

function fullEnv(extra = {}) {
  return {
    RELAY_REGISTRATION: 'open',
    RELAY_APNS_KEY: apnsKey.pem,
    RELAY_APNS_KEY_ID: KEY_ID,
    RELAY_APNS_TEAM_ID: TEAM_ID,
    RELAY_APNS_TOPIC: TOPIC,
    RELAY_APNS_HOST: fakeApns.origin,
    RELAY_FCM_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'relay@test-project.iam.gserviceaccount.com',
      private_key: saKey.pem,
      token_uri: 'https://oauth2.googleapis.com/token'
    }),
    RELAY_FCM_TOKEN_URL: fakeFcm.tokenUrl,
    RELAY_FCM_SEND_URL: fakeFcm.sendUrl,
    ...extra
  };
}

async function register(r = relay, body = {}) {
  const res = await r.call('POST', '/v1/servers', { body: { name: 'Test', url: 'https://auth.example.com', ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function subscribe(serverId, platform, token, environment = 'production', r = relay) {
  const res = await r.call('POST', '/v1/subscriptions', { body: { serverId, platform, environment, token } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.handle;
}

function pushAs(secret, body, r = relay) {
  return r.call('POST', '/v1/push', { body, headers: { authorization: `Bearer ${secret}` } });
}

before(async () => {
  apnsKey = h.apnsKeyPair();
  saKey = h.serviceAccountKeyPair();
  fakeApns = await h.startFakeApns();
  fakeFcm = await h.startFakeFcm(saKey.publicKey);
  // Many servers register from one IP here; the IP limits get their own test.
  relay = await h.startRelay({ env: fullEnv(), limits: { registration: { max: 1000 }, subscriptions: { max: 1000 } } });
});

after(async () => {
  await relay.close();
  await fakeApns.close();
  await fakeFcm.close();
});

describe('health', () => {
  it('reports which platforms are configured', async () => {
    assert.deepEqual((await relay.call('GET', '/health')).body, { status: 'ok', apns: true, fcm: true });
    const bare = await h.startRelay();
    try {
      assert.deepEqual((await bare.call('GET', '/health')).body, { status: 'ok', apns: false, fcm: false });
    } finally {
      await bare.close();
    }
  });
});

describe('server registration', () => {
  it('open mode registers without a code and returns well-formed ids', async () => {
    const { serverId, serverSecret } = await register();
    assert.match(serverId, /^srv_[A-Za-z0-9_-]{22}$/);
    assert.match(serverSecret, /^rss_[A-Za-z0-9_-]{43}$/);
    const stored = await relay.store.getServer(serverId);
    assert.equal(stored.secretHash, crypto.createHash('sha256').update(serverSecret).digest('hex'));
    assert.ok(!JSON.stringify(stored).includes(serverSecret), 'the secret itself is not stored');
  });

  it('code mode needs the right code', async () => {
    const r = await h.startRelay({ env: { RELAY_REGISTRATION: 'code', RELAY_REGISTRATION_CODE: 'letmein-123' } });
    try {
      const base = { name: 'Test', url: 'https://auth.example.com' };
      assert.equal((await r.call('POST', '/v1/servers', { body: base })).status, 403);
      assert.equal((await r.call('POST', '/v1/servers', { body: { ...base, registrationCode: 'letmein-12' } })).status, 403);
      assert.equal((await r.call('POST', '/v1/servers', { body: { ...base, registrationCode: 42 } })).status, 403);
      const ok = await r.call('POST', '/v1/servers', { body: { ...base, registrationCode: 'letmein-123' } });
      assert.equal(ok.status, 201);
      assert.ok(ok.body.serverId);
    } finally {
      await r.close();
    }
  });

  it('code is the default mode, and with no code set registration is closed', async () => {
    const r = await h.startRelay();
    try {
      assert.equal(r.config.registration, 'code');
      const res = await r.call('POST', '/v1/servers', { body: { name: 'Test', url: 'https://a.example.com', registrationCode: '' } });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /closed/);
    } finally {
      await r.close();
    }
  });

  it('validates name and url', async () => {
    assert.equal((await relay.call('POST', '/v1/servers', { body: { url: 'https://a.example.com' } })).status, 400);
    assert.equal((await relay.call('POST', '/v1/servers', { body: { name: '  ', url: 'https://a.example.com' } })).status, 400);
    assert.equal((await relay.call('POST', '/v1/servers', { body: { name: 'x', url: 'ftp://a.example.com' } })).status, 400);
    assert.equal((await relay.call('POST', '/v1/servers', { body: { name: 'x', url: 'not a url' } })).status, 400);
  });
});

describe('subscriptions', () => {
  it('is idempotent for the same server and token', async () => {
    const { serverId } = await register();
    const token = h.iosToken();
    const first = await subscribe(serverId, 'ios', token, 'sandbox');
    assert.match(first, /^sub_[A-Za-z0-9_-]{22}$/);
    assert.equal(await subscribe(serverId, 'ios', token, 'production'), first);
    assert.equal((await relay.store.getSubscription(first)).environment, 'production', 'resubscribing updates the environment');
    const other = await register();
    assert.notEqual(await subscribe(other.serverId, 'ios', token), first, 'another server gets its own handle');
  });

  it('refuses an unknown server and malformed input', async () => {
    const { serverId } = await register();
    const missing = `srv_${crypto.randomBytes(16).toString('base64url')}`;
    const post = (body) => relay.call('POST', '/v1/subscriptions', { body });
    assert.equal((await post({ serverId: missing, platform: 'ios', environment: 'production', token: h.iosToken() })).status, 404);
    assert.equal((await post({ serverId: 'srv_x', platform: 'ios', environment: 'production', token: h.iosToken() })).status, 400);
    assert.equal((await post({ serverId, platform: 'web', environment: 'production', token: h.iosToken() })).status, 400);
    assert.equal((await post({ serverId, platform: 'ios', environment: 'staging', token: h.iosToken() })).status, 400);
    assert.equal((await post({ serverId, platform: 'ios', environment: 'production', token: 'not-hex' })).status, 400);
    assert.equal((await post({ serverId, platform: 'android', environment: 'production', token: 'short' })).status, 400);
  });

  it('delete stops pushes to the handle', async () => {
    const { serverId, serverSecret } = await register();
    const handle = await subscribe(serverId, 'ios', h.iosToken());
    assert.deepEqual((await relay.call('DELETE', `/v1/subscriptions/${handle}`)).body, { ok: true });
    assert.equal(await relay.store.getSubscription(handle), null);
    const res = await pushAs(serverSecret, { handle, envelope: h.envelope() });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { gone: true });
    assert.equal((await relay.call('DELETE', '/v1/subscriptions/nope')).status, 400);
  });
});

describe('push authentication', () => {
  it('refuses a missing, malformed or unknown secret', async () => {
    const { serverId } = await register();
    const handle = await subscribe(serverId, 'ios', h.iosToken());
    const body = { handle, envelope: h.envelope() };
    assert.equal((await relay.call('POST', '/v1/push', { body })).status, 401);
    assert.equal((await pushAs('rss_short', body)).status, 401);
    const unknown = `rss_${crypto.randomBytes(32).toString('base64url')}`;
    assert.equal((await pushAs(unknown, body)).status, 401);
  });

  it("answers gone for another server's handle and sends nothing", async () => {
    const a = await register();
    const b = await register();
    const handle = await subscribe(a.serverId, 'ios', h.iosToken());
    const before = fakeApns.requests.length;
    const res = await pushAs(b.serverSecret, { handle, envelope: h.envelope() });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { gone: true });
    assert.equal(fakeApns.requests.length, before);
    assert.ok(await relay.store.getSubscription(handle), "the other server's subscription is untouched");
  });

  it('validates the push body', async () => {
    const { serverId, serverSecret } = await register();
    const handle = await subscribe(serverId, 'ios', h.iosToken());
    const env = h.envelope();
    assert.equal((await pushAs(serverSecret, { envelope: env })).status, 400);
    assert.equal((await pushAs(serverSecret, { handle, envelope: { ...env, v: 2 } })).status, 400);
    assert.equal((await pushAs(serverSecret, { handle, envelope: { ...env, n: Buffer.alloc(8).toString('base64') } })).status, 400);
    assert.equal((await pushAs(serverSecret, { handle, envelope: env, badge: -1 })).status, 400);
    assert.equal((await pushAs(serverSecret, { handle, envelope: env, badge: 1.5 })).status, 400);
    assert.equal((await pushAs(serverSecret, { handle, envelope: env, collapseId: 'x'.repeat(65) })).status, 400);
  });
});

describe('APNs', () => {
  it('sends the right headers, payload and a JWT that verifies', async () => {
    const { serverId, serverSecret } = await register();
    const token = h.iosToken();
    const handle = await subscribe(serverId, 'ios', token);
    const env = h.envelope();
    const res = await pushAs(serverSecret, { handle, envelope: env, badge: 3, collapseId: 'task-12' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });

    const req = fakeApns.requests.at(-1);
    assert.equal(req.deviceToken, token);
    assert.equal(req.headers[':method'], 'POST');
    assert.equal(req.headers['apns-topic'], TOPIC);
    assert.equal(req.headers['apns-push-type'], 'alert');
    assert.equal(req.headers['apns-collapse-id'], 'task-12');
    assert.deepEqual(req.body, {
      aps: { alert: { title: 'New Notification', body: 'Open to read.' }, 'mutable-content': 1, sound: 'default', badge: 3 },
      ad: { s: serverId, x: env }
    });

    const m = req.headers.authorization.match(/^bearer (.+)$/);
    assert.ok(m, 'authorization is a bearer token');
    const jwt = h.decodeJwt(m[1]);
    assert.deepEqual(jwt.header, { alg: 'ES256', kid: KEY_ID });
    assert.equal(jwt.claims.iss, TEAM_ID);
    assert.ok(Math.abs(jwt.claims.iat - Date.now() / 1000) < 60);
    assert.equal(jwt.signature.length, 64, 'ES256 signature is raw r||s');
    assert.ok(crypto.verify('sha256', Buffer.from(jwt.input), { key: apnsKey.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature));
  });

  it('omits badge and collapse id when not given, and reuses the JWT and session', async () => {
    const { serverId, serverSecret } = await register();
    const handle = await subscribe(serverId, 'ios', h.iosToken(), 'sandbox');
    assert.equal((await pushAs(serverSecret, { handle, envelope: h.envelope() })).status, 200);
    assert.equal((await pushAs(serverSecret, { handle, envelope: h.envelope() })).status, 200);
    const [a, b] = fakeApns.requests.slice(-2);
    assert.equal('badge' in a.body.aps, false);
    assert.equal(a.headers['apns-collapse-id'], undefined);
    assert.equal(a.headers.authorization, b.headers.authorization);
    assert.equal(fakeApns.sessions, 1, 'one HTTP/2 session for every push so far');
  });

  for (const [label, response] of [
    ['410', { status: 410, reason: 'Unregistered' }],
    ['BadDeviceToken', { status: 400, reason: 'BadDeviceToken' }]
  ]) {
    it(`${label} deletes the subscription and answers gone`, async () => {
      const { serverId, serverSecret } = await register();
      const token = h.iosToken();
      fakeApns.responses.set(token, response);
      const handle = await subscribe(serverId, 'ios', token);
      const res = await pushAs(serverSecret, { handle, envelope: h.envelope() });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { gone: true });
      assert.equal(await relay.store.getSubscription(handle), null);
      const sent = fakeApns.requests.length;
      assert.equal((await pushAs(serverSecret, { handle, envelope: h.envelope() })).status, 404);
      assert.equal(fakeApns.requests.length, sent, 'a deleted handle is not sent again');
    });
  }

  it('any other refusal is a 502 and keeps the subscription', async () => {
    const { serverId, serverSecret } = await register();
    const token = h.iosToken();
    fakeApns.responses.set(token, { status: 413, reason: 'PayloadTooLarge' });
    const handle = await subscribe(serverId, 'ios', token);
    const res = await pushAs(serverSecret, { handle, envelope: h.envelope() });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /PayloadTooLarge/);
    assert.ok(await relay.store.getSubscription(handle));
  });
});

describe('FCM', () => {
  it('exchanges a service-account JWT and sends the message', async () => {
    const { serverId, serverSecret } = await register();
    const token = h.androidToken();
    const handle = await subscribe(serverId, 'android', token);
    const env = h.envelope();
    const res = await pushAs(serverSecret, { handle, envelope: env, collapseId: 'task-12' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(fakeFcm.tokenRequests.length, 1);
    const t = fakeFcm.tokenRequests[0];
    assert.equal(t.valid, true, 'RS256 assertion verifies with the service account key');
    assert.equal(t.grantType, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.deepEqual(t.jwt.header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(t.jwt.claims.iss, 'relay@test-project.iam.gserviceaccount.com');
    assert.equal(t.jwt.claims.aud, fakeFcm.tokenUrl);
    assert.equal(t.jwt.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(t.jwt.claims.exp - t.jwt.claims.iat, 3600);

    const sent = fakeFcm.sends.at(-1);
    assert.equal(sent.authorization, 'Bearer ya29.test-access-token');
    assert.deepEqual(sent.body.message, {
      token,
      notification: { title: 'New Notification', body: 'Open to read.' },
      data: { s: serverId, x: JSON.stringify(env) },
      android: { collapse_key: 'task-12' }
    });

    assert.equal((await pushAs(serverSecret, { handle, envelope: h.envelope() })).status, 200);
    assert.equal(fakeFcm.tokenRequests.length, 1, 'the access token is cached');
  });

  it('sends the generic text alone when there is no envelope', async () => {
    const { serverId, serverSecret } = await register();
    const token = h.androidToken();
    const handle = await subscribe(serverId, 'android', token);
    const res = await pushAs(serverSecret, { handle, badge: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(fakeFcm.sends.at(-1).body.message.data, { s: serverId });
  });

  for (const [label, response] of [
    ['UNREGISTERED', { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } }],
    ['UNREGISTERED with a 400', { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } } }],
    ['a bare 404', { status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } }]
  ]) {
    it(`${label} deletes the subscription and answers gone`, async () => {
      const { serverId, serverSecret } = await register();
      const token = h.androidToken();
      fakeFcm.responses.set(token, response);
      const handle = await subscribe(serverId, 'android', token);
      const res = await pushAs(serverSecret, { handle, envelope: h.envelope() });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { gone: true });
      assert.equal(await relay.store.getSubscription(handle), null);
    });
  }
});

describe('platform without credentials', () => {
  it('answers 503 for that platform only', async () => {
    const r = await h.startRelay({ env: { RELAY_REGISTRATION: 'open', RELAY_APNS_KEY: apnsKey.pem, RELAY_APNS_KEY_ID: KEY_ID, RELAY_APNS_TEAM_ID: TEAM_ID, RELAY_APNS_TOPIC: TOPIC, RELAY_APNS_HOST: fakeApns.origin } });
    try {
      const { serverId, serverSecret } = await register(r);
      const android = await subscribe(serverId, 'android', h.androidToken(), 'production', r);
      const ios = await subscribe(serverId, 'ios', h.iosToken(), 'production', r);
      const res = await pushAs(serverSecret, { handle: android, envelope: h.envelope() }, r);
      assert.equal(res.status, 503);
      assert.match(res.body.error, /Android/);
      assert.equal((await pushAs(serverSecret, { handle: ios, envelope: h.envelope() }, r)).status, 200);
    } finally {
      await r.close();
    }
  });

  it('a relay with no credentials answers 503 for iOS', async () => {
    const r = await h.startRelay({ env: { RELAY_REGISTRATION: 'open' } });
    try {
      const { serverId, serverSecret } = await register(r);
      const ios = await subscribe(serverId, 'ios', h.iosToken(), 'production', r);
      assert.equal((await pushAs(serverSecret, { handle: ios, envelope: h.envelope() }, r)).status, 503);
    } finally {
      await r.close();
    }
  });
});

describe('rate limits', () => {
  it('allows 600 pushes per server per minute', async () => {
    const a = await register();
    const b = await register();
    const missing = `sub_${crypto.randomBytes(16).toString('base64url')}`;
    for (let i = 0; i < 600; i++) {
      const res = await pushAs(a.serverSecret, { handle: missing, envelope: h.envelope() });
      assert.equal(res.status, 404, `push ${i + 1}`);
    }
    const over = await pushAs(a.serverSecret, { handle: missing, envelope: h.envelope() });
    assert.equal(over.status, 429);
    assert.ok(over.body.error);
    assert.equal((await pushAs(b.serverSecret, { handle: missing, envelope: h.envelope() })).status, 404, 'other servers are not affected');
  });

  it('limits subscriptions and registrations by IP', async () => {
    const r = await h.startRelay({ env: { RELAY_REGISTRATION: 'open' }, limits: { subscriptions: { max: 3 }, registration: { max: 2 } } });
    try {
      const { serverId } = await register(r);
      await register(r);
      assert.equal((await r.call('POST', '/v1/servers', { body: { name: 'x', url: 'https://a.example.com' } })).status, 429);
      for (let i = 0; i < 3; i++) await subscribe(serverId, 'ios', h.iosToken(), 'production', r);
      const res = await r.call('POST', '/v1/subscriptions', { body: { serverId, platform: 'ios', environment: 'production', token: h.iosToken() } });
      assert.equal(res.status, 429);
    } finally {
      await r.close();
    }
  });

  it('keys on X-Forwarded-For only from the trusted proxy', async () => {
    const limits = { registration: { max: 1 } };
    const body = { name: 'x', url: 'https://a.example.com' };
    const post = (r, ip) => r.call('POST', '/v1/servers', { body, headers: { 'x-forwarded-for': ip } });

    const trusting = await h.startRelay({ env: { RELAY_REGISTRATION: 'open', RELAY_TRUST_PROXY: '127.0.0.1' }, limits });
    try {
      assert.equal((await post(trusting, '203.0.113.1')).status, 201);
      assert.equal((await post(trusting, '203.0.113.2')).status, 201);
      assert.equal((await post(trusting, '203.0.113.1')).status, 429);
    } finally {
      await trusting.close();
    }

    const untrusting = await h.startRelay({ env: { RELAY_REGISTRATION: 'open' }, limits });
    try {
      assert.equal((await post(untrusting, '203.0.113.1')).status, 201);
      assert.equal((await post(untrusting, '203.0.113.2')).status, 429, 'a spoofed header does not reset the limit');
    } finally {
      await untrusting.close();
    }
  });
});

describe('request handling', () => {
  function rawPost(path, chunks, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: relay.port, path, method: 'POST', headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      for (const c of chunks) req.write(c);
      req.end();
    });
  }

  it('refuses a body over 16 KB, declared or streamed', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(17 * 1024), url: 'https://a.example.com' });
    const declared = await relay.call('POST', '/v1/servers', { body: big });
    assert.equal(declared.status, 413);
    assert.ok(declared.body.error);
    const streamed = await rawPost('/v1/servers', [big.slice(0, 9000), big.slice(9000)], { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    assert.equal(streamed.status, 413);
  });

  it('answers JSON errors for bad JSON and unknown routes', async () => {
    const bad = await relay.call('POST', '/v1/servers', { body: '{not json' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);
    const arr = await relay.call('POST', '/v1/servers', { body: '[]' });
    assert.equal(arr.status, 400);
    const missing = await relay.call('GET', '/v1/nothing');
    assert.equal(missing.status, 404);
    assert.ok(missing.body.error);
  });

  it('logs one line per push without tokens, envelopes or secrets', async () => {
    const { serverId, serverSecret } = await register();
    const token = h.iosToken();
    const handle = await subscribe(serverId, 'ios', token);
    const env = h.envelope();
    const before = relay.lines.length;
    await pushAs(serverSecret, { handle, envelope: env });
    const lines = relay.lines.slice(before);
    assert.deepEqual(lines, [`push server=${serverId} platform=ios status=sent`]);

    const all = relay.lines.join('\n');
    assert.ok(!all.includes(token));
    assert.ok(!all.includes(serverSecret));
    assert.ok(!all.includes(env.c));
    assert.ok(!all.includes(handle));
  });
});
