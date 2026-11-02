'use strict';

// The pieces that do not need a running relay.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
const { normalizePem } = require('../src/jwt');
const { loadConfig } = require('../src/config');
const { createApns, HOSTS } = require('../src/apns');
const { createLimiter } = require('../src/rate-limit');
const { DEFAULT_LIMITS } = require('../src/app');
const ids = require('../src/ids');

describe('normalizePem', () => {
  const { pem } = h.apnsKeyPair();

  it('restores a key whose newlines became spaces or literal \\n', () => {
    for (const mangled of [pem.replace(/\n/g, ' '), pem.replace(/\n/g, '\\n'), `  ${pem}  `]) {
      assert.doesNotThrow(() => crypto.createPrivateKey(normalizePem(mangled)));
    }
  });
});

describe('loadConfig', () => {
  it('reads the database URL and port with their fallbacks', () => {
    assert.equal(loadConfig({ RELAY_DATABASE_URL: 'a', ASTRODOCK_DATABASE_URL: 'b' }).databaseUrl, 'a');
    assert.equal(loadConfig({ ASTRODOCK_DATABASE_URL: 'b' }).databaseUrl, 'b');
    assert.equal(loadConfig({ ASTRODOCK_PORT: '4100', PORT: '5000' }).port, 4100);
    assert.equal(loadConfig({ PORT: '5000' }).port, 5000);
  });

  it('turns a platform off when its credentials are incomplete or unreadable', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    assert.equal(loadConfig({ RELAY_APNS_KEY_ID: 'x' }, warn).apns, null);
    assert.equal(loadConfig({ RELAY_APNS_KEY: 'junk', RELAY_APNS_KEY_ID: 'k', RELAY_APNS_TEAM_ID: 't', RELAY_APNS_TOPIC: 'b' }, warn).apns, null);
    assert.equal(loadConfig({ RELAY_FCM_SERVICE_ACCOUNT: '{' }, warn).fcm, null);
    assert.equal(loadConfig({ RELAY_FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' }, warn).fcm, null);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((w) => !w.includes('junk')), 'warnings do not echo values');
  });

  it('defaults the FCM URLs from the service account', () => {
    const { pem } = h.serviceAccountKeyPair();
    const fcm = loadConfig({ RELAY_FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'proj-1', client_email: 'a@b', private_key: pem }) }).fcm;
    assert.equal(fcm.tokenUrl, 'https://oauth2.googleapis.com/token');
    assert.equal(fcm.sendUrl, 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  });

  it('refuses an unknown registration mode', () => {
    assert.throws(() => loadConfig({ RELAY_REGISTRATION: 'maybe' }));
  });
});

describe('APNs client', () => {
  const { pem } = h.apnsKeyPair();
  const key = crypto.createPrivateKey(pem);

  it('picks the host by environment', () => {
    const apns = createApns({ key, keyId: 'k', teamId: 't', topic: 'b' });
    assert.equal(apns.originFor('sandbox'), 'https://api.sandbox.push.apple.com');
    assert.equal(apns.originFor('production'), 'https://api.push.apple.com');
    assert.equal(HOSTS.production, 'https://api.push.apple.com');
  });

  it('reuses the provider JWT for under 50 minutes', () => {
    const apns = createApns({ key, keyId: 'k', teamId: 't', topic: 'b' });
    const realNow = Date.now;
    const start = realNow();
    try {
      Date.now = () => start;
      const first = apns.token();
      Date.now = () => start + 49 * 60 * 1000;
      assert.equal(apns.token(), first);
      Date.now = () => start + 50 * 60 * 1000;
      assert.notEqual(apns.token(), first);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('rate limiter', () => {
  it('counts per key within a window', () => {
    const l = createLimiter({ max: 2, windowMs: 60000 });
    try {
      assert.equal(l.hit('a'), true);
      assert.equal(l.hit('a'), true);
      assert.equal(l.hit('a'), false);
      assert.equal(l.hit('b'), true);
    } finally {
      l.close();
    }
  });

  it('defaults push to 600 per minute', () => {
    assert.deepEqual(DEFAULT_LIMITS.push, { max: 600, windowMs: 60000 });
  });
});

describe('ids', () => {
  it('compares in constant time without throwing on length differences', () => {
    assert.equal(ids.safeEqual('abc', 'abc'), true);
    assert.equal(ids.safeEqual('abc', 'abcd'), false);
    assert.equal(ids.safeEqualHex(ids.sha256('x'), ids.sha256('x')), true);
    assert.equal(ids.safeEqualHex(ids.sha256('x'), 'ab'), false);
  });
});
