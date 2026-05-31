const mongoose = require('mongoose');

const envVarSchema = new mongoose.Schema({
  key: { type: String, required: true },
  value: { type: String, required: true },
  isSystem: { type: Boolean, default: false }
}, { _id: false });

const appSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  appSecret: {
    type: String,
    required: true
  },
  subdomain: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  port: {
    type: Number,
    required: true
  },
  usePlatformAuth: {
    type: Boolean,
    default: true
  },
  usePlatformDb: {
    type: Boolean,
    default: true
  },
  isProvisioned: {
    type: Boolean,
    default: false
  },

  // GitHub integration
  githubRepo: {
    type: String,
    default: ''
  },
  branch: {
    type: String,
    default: 'main'
  },
  // Subdirectory in the repo to deploy from (e.g., "packages/admin" or "services/api")
  // Empty means repo root
  repoPath: {
    type: String,
    default: ''
  },
  webhookId: {
    type: Number,
    default: null
  },
  webhookSecret: {
    type: String,
    default: ''
  },

  // Build configuration
  buildCommand: {
    type: String,
    default: 'npm run build'
  },

  // Environment variables
  envVars: {
    type: [envVarSchema],
    default: []
  }
}, {
  timestamps: true
});

appSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.appSecret;
  delete obj.webhookSecret;
  delete obj.__v;
  // Mask env var values
  if (obj.envVars) {
    obj.envVars = obj.envVars.map(v => ({
      ...v,
      value: v.isSystem ? '••••••' : v.value
    }));
  }
  return obj;
};

// Get the raw env vars (unmasked) for writing .env files
appSchema.methods.getRawEnvVars = function () {
  return this.envVars;
};

module.exports = mongoose.model('App', appSchema);
