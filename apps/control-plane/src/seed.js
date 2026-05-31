require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { connectDB } = require('./lib/db');
const User = require('./models/User');

const BCRYPT_ROUNDS = 12;

async function seed() {
  await connectDB();

  const email = process.env.ADMIN_EMAIL || 'admin@seniorverse.dev';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error('Set ADMIN_PASSWORD environment variable before seeding.');
    process.exit(1);
  }

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin user ${email} already exists — skipping.`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await User.create({
    email,
    name: 'Admin',
    passwordHash,
    isActive: true,
    isAdmin: true,
    appAccess: []
  });

  console.log(`Admin user created: ${email}`);
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
