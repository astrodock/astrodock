'use strict';

const { eq } = require('drizzle-orm');
const config = require('./config');
const { db, schema, close } = require('./db');
const { hashPassword } = require('./lib/passwords');

// Seed the initial admin from env. Idempotent: if the admin email already
// exists, does nothing. Safe to call on every boot.
async function seedAdmin({ log = console.log } = {}) {
  const email = (config.adminEmail || '').toLowerCase().trim();
  const password = config.adminPassword;

  if (!email || !password) {
    log('[seed] ASTRODOCK_ADMIN_EMAIL / ASTRODOCK_ADMIN_PASSWORD not set — skipping admin seed.');
    return { seeded: false };
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing[0]) {
    log(`[seed] admin ${email} already exists — skipping.`);
    return { seeded: false };
  }

  const passwordHash = await hashPassword(password);
  await db.insert(schema.users).values({
    email, name: 'Admin', passwordHash, isActive: true, isAdmin: true, appAccess: []
  });
  log(`[seed] admin user created: ${email}`);
  return { seeded: true };
}

module.exports = { seedAdmin };

// Run directly: `node src/seed.js`
if (require.main === module) {
  seedAdmin()
    .then(() => close())
    .then(() => process.exit(0))
    .catch((err) => { console.error('[seed] failed:', err.message); process.exit(1); });
}
