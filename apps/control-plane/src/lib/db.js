const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is required');

  await mongoose.connect(uri, { dbName: 'auth' });
  console.log('Connected to MongoDB (auth database)');
}

module.exports = { connectDB };
