'use strict';

// Minimal, self-contained migration runner: applies every *.sql file in
// ./migrations in lexical order exactly once, tracking applied files in a
// schema_migrations table. No drizzle-kit journal dependency — the .sql files
// are the source of truth and are hand-kept in sync with schema.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const postgres = require('postgres');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function migrate({ url = config.pg.url, log = console.log } = {}) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    // back-fill the column on a schema_migrations created before checksums existed
    await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const appliedRows = await sql`SELECT name, checksum FROM schema_migrations`;
    const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));

    let count = 0;
    for (const file of files) {
      const ddl = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksum(ddl);
      if (applied.has(file)) {
        const prev = applied.get(file);
        if (prev && prev !== sum) {
          throw new Error(`migration ${file} changed after being applied (checksum mismatch) — never edit an applied migration; add a new one`);
        }
        if (!prev) await sql`UPDATE schema_migrations SET checksum = ${sum} WHERE name = ${file}`;
        continue;
      }
      log(`[migrate] applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${sum})`;
      });
      count++;
    }
    log(count ? `[migrate] applied ${count} migration(s)` : '[migrate] up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

module.exports = { migrate };

// Run directly: `node src/db/migrate.js`
if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((err) => {
    console.error('[migrate] failed:', err.message);
    process.exit(1);
  });
}
