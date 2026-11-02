'use strict';

// Postgres store. The two tables are created at startup if they are missing;
// the relay has no other schema to migrate.

const postgres = require('postgres');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_servers (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  url         text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay_subscriptions (
  handle      text PRIMARY KEY,
  server_id   text NOT NULL REFERENCES relay_servers(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  environment text NOT NULL,
  token       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, token)
);
`;

const toServer = (r) => r && ({ id: r.id, name: r.name, url: r.url, secretHash: r.secret_hash, createdAt: r.created_at });
const toSubscription = (r) => r && ({
  handle: r.handle, serverId: r.server_id, platform: r.platform, environment: r.environment,
  token: r.token, createdAt: r.created_at, updatedAt: r.updated_at
});

function createPostgresStore(url) {
  // onnotice: CREATE TABLE IF NOT EXISTS reports "already exists" as a notice
  // on every start, which is noise.
  const sql = postgres(url, { max: 5, onnotice: () => {} });

  return {
    sql, // for test cleanup

    async init() {
      await sql.unsafe(SCHEMA);
    },

    async close() {
      await sql.end({ timeout: 5 });
    },

    async createServer({ id, name, url: serverUrl, secretHash }) {
      await sql`INSERT INTO relay_servers (id, name, url, secret_hash) VALUES (${id}, ${name}, ${serverUrl}, ${secretHash})`;
    },

    async getServer(id) {
      const [row] = await sql`SELECT * FROM relay_servers WHERE id = ${id}`;
      return toServer(row) || null;
    },

    async getServerBySecretHash(secretHash) {
      const [row] = await sql`SELECT * FROM relay_servers WHERE secret_hash = ${secretHash}`;
      return toServer(row) || null;
    },

    // One statement, so two devices racing to subscribe the same token still
    // end with one row and one handle.
    async upsertSubscription({ handle, serverId, platform, environment, token }) {
      const [row] = await sql`
        INSERT INTO relay_subscriptions (handle, server_id, platform, environment, token)
        VALUES (${handle}, ${serverId}, ${platform}, ${environment}, ${token})
        ON CONFLICT (server_id, token) DO UPDATE
          SET platform = EXCLUDED.platform, environment = EXCLUDED.environment, updated_at = now()
        RETURNING handle`;
      return row.handle;
    },

    async getSubscription(handle) {
      const [row] = await sql`SELECT * FROM relay_subscriptions WHERE handle = ${handle}`;
      return toSubscription(row) || null;
    },

    async deleteSubscription(handle) {
      const rows = await sql`DELETE FROM relay_subscriptions WHERE handle = ${handle} RETURNING handle`;
      return rows.length > 0;
    }
  };
}

module.exports = { createPostgresStore };
