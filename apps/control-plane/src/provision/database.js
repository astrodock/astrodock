'use strict';

// Internal database provisioner: create a dedicated Postgres database + login
// role on the bundled Postgres for an app in `database.mode = internal`.
// Idempotent — safe to re-run; reuses the app's stored credentials.

const postgres = require('postgres');
const config = require('../config');
const { generateSecretHex } = require('../lib/ids');

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
    const password = app.dbPassword || generateSecretHex(24);

    const roleExists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
    if (roleExists.length === 0) {
      await admin.unsafe(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      // ensure the password matches what we'll inject
      await admin.unsafe(`ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
    }

    const dbExists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbname}`;
    if (dbExists.length === 0) {
      // CREATE DATABASE cannot run inside a transaction block
      await admin.unsafe(`CREATE DATABASE ${quoteIdent(dbname)} OWNER ${quoteIdent(role)}`);
    }

    return { dbName: dbname, dbUser: role, dbPassword: password, created: dbExists.length === 0 };
  } finally {
    await admin.end({ timeout: 5 });
  }
}

module.exports = { provisionDatabase, ident };
