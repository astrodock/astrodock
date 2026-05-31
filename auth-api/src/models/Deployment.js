const mongoose = require('mongoose');

const deploymentSchema = new mongoose.Schema({
  appSlug: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'cloning', 'building', 'deploying', 'success', 'failed'],
    default: 'pending'
  },
  trigger: {
    type: String,
    enum: ['webhook', 'manual'],
    default: 'manual'
  },
  commitHash: {
    type: String,
    default: ''
  },
  commitMessage: {
    type: String,
    default: ''
  },
  log: {
    type: String,
    default: ''
  },
  error: {
    type: String,
    default: ''
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  finishedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Deployment', deploymentSchema);
