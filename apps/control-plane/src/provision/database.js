'use strict';

// Internal database provisioner: create a dedicated Postgres database + login
// role on the bundled Postgres for an app in `database.mode = internal`.
// Idempotent — safe to re-run; reuses the app's stored credentials.

const postgres = require('postgres');
const config = require('../config');
const { generateSecretHex } = require('../lib/ids');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

function ident(slug) {
  // role/db base name: slugs are [a-z0-9-]; map '-' to '_' for SQL identifiers
  return 'app_' + slug.replace(/[^a-z0-9]/g, '_');
}
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function quoteLiteral(val) {
  return "'" + String(val).replace(/'/g, "''") + "'";
}

async function provisionDatabase(app) {
  const admin = postgres(config.pg.url, { max: 1, onnotice: () => {} });
  try {
    const role = ident(app.slug);
    const dbname = ident(app.slug);
    // reuse the stored (decrypted) password on re-provision; generate one otherwise
    const password = app.dbPassword ? decryptSecret(app.dbPassword) : generateSecretHex(24);

    const roleExists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
    if (roleExists.length === 0) {
      await admin.unsafe(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      await admin.unsafe(`ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
    }

    const dbExists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbname}`;
    if (dbExists.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${quoteIdent(dbname)} OWNER ${quoteIdent(role)}`);
    }

    // #3: only this app's role may connect to this DB — not every PUBLIC role.
    await admin.unsafe(`REVOKE CONNECT ON DATABASE ${quoteIdent(dbname)} FROM PUBLIC`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${quoteIdent(dbname)} TO ${quoteIdent(role)}`);

    return { dbName: dbname, dbUser: role, dbPassword: encryptSecret(password), created: dbExists.length === 0 };
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// Drop an app's internal database + role (used on delete with ?purge=true).
async function dropDatabase(app) {
  if (!app.dbName) return;
  const admin = postgres(config.pg.url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(app.dbName)} AND pid <> pg_backend_pid()`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(app.dbName)}`);
    if (app.dbUser) await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(app.dbUser)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// Prevent app roles from connecting to the control-plane database itself.
async function lockdownControlPlaneDb() {
  const admin = postgres(config.pg.url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`REVOKE CONNECT ON DATABASE ${quoteIdent(config.pg.database)} FROM PUBLIC`);
  } catch (err) {
    console.error('[provision] control-plane DB lockdown skipped:', err.message);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

module.exports = { provisionDatabase, dropDatabase, lockdownControlPlaneDb, ident };
