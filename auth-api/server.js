require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { connectDB } = require('./src/lib/db');

const verifyRoutes = require('./src/routes/verify');
const adminAuthRoutes = require('./src/routes/admin-auth');
const adminUsersRoutes = require('./src/routes/admin-users');
const adminAppsRoutes = require('./src/routes/admin-apps');
const adminActivityRoutes = require('./src/routes/admin-activity');
const adminHealthRoutes = require('./src/routes/admin-health');
const accountRoutes = require('./src/routes/account');
const webhookRoutes = require('./src/routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3100;

// Trust one proxy (Caddy) so express-rate-limit and req.ip work correctly
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow *.seniorverse.dev and localhost for dev
    if (/^https?:\/\/(.*\.)?seniorverse\.dev$/.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
// Webhook route MUST come before express.json() because it needs raw body
app.use('/webhooks', webhookRoutes);

app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve account page
app.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

// Routes
app.use('/verify', verifyRoutes);
app.use('/admin', adminAuthRoutes);
app.use('/admin/health', adminHealthRoutes);
app.use('/admin/users', adminUsersRoutes);
app.use('/admin/apps', adminAppsRoutes);
app.use('/admin/activity', adminActivityRoutes);
app.use('/account', accountRoutes);

// Start
async function start() {
  await connectDB();

  const { startHealthChecker } = require('./src/lib/health-checker');
  startHealthChecker();

  app.listen(PORT, () => {
    console.log(`Auth API running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start auth API:', err);
  process.exit(1);
});
