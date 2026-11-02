'use strict';

// The store contract, run against the in-memory store and, when
// RELAY_TEST_DATABASE_URL is set, against Postgres. The Postgres run creates
// the relay tables if they are missing and deletes only the rows it added.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const ids = require('../src/ids');
const { createMemoryStore } = require('../src/store/memory');
const { createPostgresStore } = require('../src/store/postgres');

const pgUrl = process.env.RELAY_TEST_DATABASE_URL;

function contract(name, makeStore, { skip } = {}) {
  describe(`${name} store`, { skip }, () => {
    let store;
    const serverIds = [];

    after(async () => {
      if (!store) return;
      if (store.sql) {
        await store.sql`DELETE FROM relay_servers WHERE id = ANY(${serverIds})`;
      }
      await store.close();
    });

    async function ready() {
      if (!store) {
        store = makeStore();
        await store.init();
      }
      return store;
    }

    async function newServer() {
      const s = await ready();
      const id = ids.newServerId();
      serverIds.push(id);
      const secretHash = ids.sha256(ids.newServerSecret());
      await s.createServer({ id, name: 'Test', url: 'https://a.example.com', secretHash });
      return { id, secretHash };
    }

    it('stores and finds servers by id and secret hash', async () => {
      const s = await ready();
      const { id, secretHash } = await newServer();
      assert.equal((await s.getServer(id)).secretHash, secretHash);
      assert.equal((await s.getServerBySecretHash(secretHash)).id, id);
      assert.equal(await s.getServer(ids.newServerId()), null);
      assert.equal(await s.getServerBySecretHash(ids.sha256('nope')), null);
    });

    it('upserts subscriptions by server and token', async () => {
      const s = await ready();
      const a = await newServer();
      const b = await newServer();
      const token = 'ab'.repeat(32);
      const h1 = await s.upsertSubscription({ handle: ids.newHandle(), serverId: a.id, platform: 'ios', environment: 'sandbox', token });
      const h2 = await s.upsertSubscription({ handle: ids.newHandle(), serverId: a.id, platform: 'ios', environment: 'production', token });
      const h3 = await s.upsertSubscription({ handle: ids.newHandle(), serverId: b.id, platform: 'ios', environment: 'production', token });
      assert.equal(h2, h1);
      assert.notEqual(h3, h1);
      const sub = await s.getSubscription(h1);
      assert.equal(sub.serverId, a.id);
      assert.equal(sub.environment, 'production');
      assert.equal(sub.token, token);
    });

    it('deletes subscriptions', async () => {
      const s = await ready();
      const a = await newServer();
      const handle = await s.upsertSubscription({ handle: ids.newHandle(), serverId: a.id, platform: 'android', environment: 'production', token: 'tok_' + 'x'.repeat(40) });
      assert.equal(await s.deleteSubscription(handle), true);
      assert.equal(await s.getSubscription(handle), null);
      assert.equal(await s.deleteSubscription(handle), false);
    });
  });
}

contract('memory', createMemoryStore);
contract('postgres', () => createPostgresStore(pgUrl), { skip: pgUrl ? false : 'RELAY_TEST_DATABASE_URL not set' });
