#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# SV Platform — Automated Deployment
# Run this from your local machine. It will:
#   1. Install all software on the Droplet (Node, PM2, Caddy, git)
#   2. Create directory structure and deploy user
#   3. Deploy the auth API and admin UI
#   4. Configure Caddy and PM2
#   5. Seed the admin user
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONF_FILE="${SCRIPT_DIR}/setup.conf"

# ── Load config ───────────────────────────────────────────

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: setup.conf not found."
  echo "Copy setup.conf.example to setup.conf and fill in your values."
  exit 1
fi

source "$CONF_FILE"

# Validate required values
for var in DROPLET_IP MONGODB_URI SPACES_KEY SPACES_SECRET GITHUB_PAT GITHUB_OWNER ADMIN_EMAIL ADMIN_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set in setup.conf"
    exit 1
  fi
done

# Generate secrets if not provided
if [ -z "${ADMIN_JWT_SECRET:-}" ]; then
  ADMIN_JWT_SECRET=$(openssl rand -hex 32)
  echo "Generated ADMIN_JWT_SECRET"
fi

SSH_KEY="${SSH_KEY:-~/.ssh/id_ed25519}"
BASE_DOMAIN="${BASE_DOMAIN:-seniorverse.dev}"
SPACES_REGION="${SPACES_REGION:-nyc3}"
SPACES_BUCKET="${SPACES_BUCKET:-sv-tools-data}"

SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"
SCP_CMD="scp -i $SSH_KEY -o StrictHostKeyChecking=no"

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║        SV Platform Deployment             ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "  Droplet:  $DROPLET_IP"
echo "  Domain:   $BASE_DOMAIN"
echo "  Admin:    $ADMIN_EMAIL"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi

# ── Step 1: Install software on Droplet ───────────────────

echo ""
echo "━━━ Step 1: Installing software on Droplet ━━━"

$SSH_CMD root@$DROPLET_IP << 'INSTALL_EOF'
set -euo pipefail

# Node.js 20 LTS
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "Node.js already installed: $(node --version)"
fi

# PM2
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
else
  echo "PM2 already installed"
fi

# Caddy
if ! command -v caddy &> /dev/null; then
  echo "Installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
else
  echo "Caddy already installed"
fi

# Git
apt-get install -y git rsync

# Firewall
echo "Configuring firewall..."
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

echo "Software installation complete"
INSTALL_EOF

# ── Step 2: Create deploy user and directories ────────────

echo ""
echo "━━━ Step 2: Setting up deploy user and directories ━━━"

$SSH_CMD root@$DROPLET_IP << 'SETUP_EOF'
set -euo pipefail

# Create deploy user if it doesn't exist
if ! id "deploy" &>/dev/null; then
  adduser --disabled-password --gecos "" deploy
  mkdir -p /home/deploy/.ssh
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/
  chown -R deploy:deploy /home/deploy/.ssh
  chmod 700 /home/deploy/.ssh
  echo "Created deploy user"
else
  echo "Deploy user already exists"
fi

# Create directories
mkdir -p /var/www /opt/apps /opt/repos /etc/caddy
chown -R deploy:deploy /var/www /opt/apps /opt/repos
touch /etc/caddy/Caddyfile
chown deploy:deploy /etc/caddy/Caddyfile

# Allow deploy user to reload Caddy
if ! grep -q "deploy.*caddy" /etc/sudoers.d/deploy 2>/dev/null; then
  echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/caddy reload *" > /etc/sudoers.d/deploy
  chmod 440 /etc/sudoers.d/deploy
  echo "Added sudoers entry for caddy reload"
fi

echo "Directory structure ready"
SETUP_EOF

# ── Step 3: Build auth-admin locally ──────────────────────

echo ""
echo "━━━ Step 3: Building auth-admin UI locally ━━━"

cd "$PROJECT_DIR/auth-admin"
npm ci
npm run build
echo "Auth admin built successfully"

# ── Step 4: Copy files to Droplet ─────────────────────────

echo ""
echo "━━━ Step 4: Copying files to Droplet ━━━"

# Auth API
echo "Uploading auth-api..."
$SSH_CMD deploy@$DROPLET_IP "mkdir -p /opt/apps/auth-api"
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$PROJECT_DIR/auth-api/" deploy@$DROPLET_IP:/opt/apps/auth-api/

# Auth Admin UI
echo "Uploading auth-admin..."
$SSH_CMD deploy@$DROPLET_IP "mkdir -p /var/www/auth-admin"
rsync -az --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$PROJECT_DIR/auth-admin/dist/" deploy@$DROPLET_IP:/var/www/auth-admin/

echo "Files uploaded"

# ── Step 5: Write .env and install dependencies ───────────

echo ""
echo "━━━ Step 5: Configuring auth-api ━━━"

$SSH_CMD deploy@$DROPLET_IP << EOF
set -euo pipefail

# Write .env (only if it doesn't exist, to avoid overwriting)
if [ ! -f /opt/apps/auth-api/.env ]; then
  cat > /opt/apps/auth-api/.env << 'ENVFILE'
PORT=3100
MONGODB_URI=${MONGODB_URI}
ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET}
GITHUB_PAT=${GITHUB_PAT}
GITHUB_OWNER=${GITHUB_OWNER}
BASE_DOMAIN=${BASE_DOMAIN}
CADDY_FILE=/etc/caddy/Caddyfile
STATIC_DIR=/var/www
APPS_DIR=/opt/apps
REPOS_DIR=/opt/repos
SPACES_REGION=${SPACES_REGION}
SPACES_BUCKET=${SPACES_BUCKET}
SPACES_KEY=${SPACES_KEY}
SPACES_SECRET=${SPACES_SECRET}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ENVFILE
  echo "Created .env"
else
  echo ".env already exists — skipping (delete it manually to regenerate)"
fi

# Install dependencies
cd /opt/apps/auth-api
npm ci --production
echo "Dependencies installed"
EOF

# ── Step 6: Configure Caddy ──────────────────────────────

echo ""
echo "━━━ Step 6: Configuring Caddy ━━━"

$SSH_CMD root@$DROPLET_IP << EOF
cat > /etc/caddy/Caddyfile << 'CADDYFILE'
auth.${BASE_DOMAIN} {
    @api path /admin/* /verify /webhooks/* /health
    handle @api {
        reverse_proxy localhost:3100
    }
    handle {
        root * /var/www/auth-admin
        try_files {path} /index.html
        file_server
    }
}
CADDYFILE

caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || caddy start --config /etc/caddy/Caddyfile
echo "Caddy configured"
EOF

# ── Step 7: Seed admin user and start PM2 ─────────────────

echo ""
echo "━━━ Step 7: Starting auth-api ━━━"

$SSH_CMD deploy@$DROPLET_IP << 'PM2_EOF'
set -euo pipefail

cd /opt/apps/auth-api

# Seed admin user
echo "Seeding admin user..."
npm run seed || true

# Start or restart with PM2
if pm2 describe auth-api > /dev/null 2>&1; then
  pm2 restart auth-api
  echo "PM2 process restarted"
else
  pm2 start server.js --name auth-api
  pm2 save
  echo "PM2 process started"
fi

# Set up PM2 to start on boot (may need root)
pm2 startup 2>/dev/null || true
PM2_EOF

# ── Step 8: Verify ────────────────────────────────────────

echo ""
echo "━━━ Step 8: Verifying deployment ━━━"

sleep 3

HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "https://auth.${BASE_DOMAIN}/health" 2>/dev/null || echo "000")

if [ "$HEALTH_CHECK" = "200" ]; then
  echo "Health check passed!"
else
  echo "Health check returned $HEALTH_CHECK (may take a moment for HTTPS cert to provision)"
  echo "Try: curl https://auth.${BASE_DOMAIN}/health"
fi

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║        Deployment Complete!               ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "  Admin UI:  https://auth.${BASE_DOMAIN}"
echo "  Login:     ${ADMIN_EMAIL}"
echo ""
echo "  Next steps:"
echo "  1. Log in to the admin UI"
echo "  2. Register your first app"
echo "  3. Connect a GitHub repo"
echo "  4. Push code and watch it deploy"
echo ""
