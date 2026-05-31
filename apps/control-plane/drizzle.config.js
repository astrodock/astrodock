'use strict';

// drizzle-kit config. Migrations are hand-kept SQL under src/db/migrations and
// applied by src/db/migrate.js. This config lets you run `npx drizzle-kit ...`
// to introspect / generate diffs against the live schema when iterating.

const config = require('./src/config');

module.exports = {
  schema: './src/db/schema.js',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: config.pg.url }
};
