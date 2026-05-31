'use strict';

const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const config = require('../config');
const schema = require('./schema');

// One pooled connection to the bundled Postgres (control-plane store).
const client = postgres(config.pg.url, {
  max: 10,
  onnotice: () => {} // quiet NOTICE spam
});

const db = drizzle(client, { schema });

async function ping() {
  await client`select 1`;
}

async function close() {
  await client.end({ timeout: 5 });
}

module.exports = { db, client, schema, ping, close };
