const mongoose = require('mongoose');

const authLogSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true
  },
  appId: {
    type: String,
    required: true
  },
  result: {
    type: String,
    enum: ['SUCCESS', 'BAD_PASSWORD', 'USER_NOT_FOUND', 'INACTIVE_USER', 'NO_ACCESS', 'INVALID_APP_SECRET', 'PASSWORD_CHANGED', 'PASSWORD_CHANGE_BAD_PASSWORD'],
    required: true
  },
  ip: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Auto-expire logs after 90 days
authLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AuthLog', authLogSchema);
