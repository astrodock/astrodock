# SV Platform Deployment Guide

Deploys the auth service (API + admin UI) onto a DigitalOcean Droplet with Caddy, PM2, and managed MongoDB. All services live on one Droplet behind Caddy's automatic HTTPS.

---

## 1. Prerequisites

- **DigitalOcean account** with billing enabled
- **Domain:** `seniorverse.dev` with DNS managed by DigitalOcean (or ability to set A records)
- **GitHub account** with access to the SV repos
- **Local machine** with Node.js 20+, git, and an SSH key

---

## 2. Create DigitalOcean Resources

### 2.1 Droplet

Create via DO console or CLI:

- **Image:** Ubuntu 24.04 LTS
- **Size:** 2 GB RAM / 1 vCPU ($12/mo) — upgrade to 2 vCPU ($24/mo) if running multiple apps
- **Region:** NYC3 (or wherever your users are)
- **Auth:** Add your SSH key
- **Hostname:** `sv-platform`

Note the Droplet IP (referred to as `DROPLET_IP` below).

### 2.2 Managed MongoDB

- Create a MongoDB cluster in DigitalOcean Databases
- **Size:** Smallest available (~$15/mo)
- **Region:** Same as the Droplet
- Add the Droplet to the cluster's trusted sources
- Copy the connection string — it will look like:
  ```
  mongodb+srv://doadmin:PASSWORD@db-mongodb-nyc3-xxxxx.mongo.ondigitalocean.com/?retryWrites=true&w=majority
  ```

### 2.3 DO Spaces

- Create a Space:
  - **Name:** `sv-tools-data`
  - **Region:** nyc3
- Generate a Spaces access key pair (Settings > API > Spaces Keys)
- Save the key and secret

---

## 3. DNS

In your DNS provider, create a wildcard A record:

```
Type: A
Host: *
Value: DROPLET_IP
TTL: 300
```

This routes `auth.seniorverse.dev`, `model.seniorverse.dev`, and any future subdomains to the Droplet. Also add a root A record if you want `seniorverse.dev` itself to resolve:

```
Type: A
Host: @
Value: DROPLET_IP
TTL: 300
```

---

## 4. GitHub PAT

Create a fine-grained Personal Access Token at https://github.com/settings/personal-access-tokens:

- **Token name:** `sv-platform-deploy`
- **Expiration:** 90 days (or custom)
- **Repository access:** Select the SV repos
- **Permissions:**
  - Contents: Read
  - Webhooks: Read and Write

Save the token — it goes into the auth-api `.env` as `GITHUB_PAT`.

---

## 5. Droplet Setup

SSH into the Droplet as root:

```bash
ssh root@DROPLET_IP
```

### 5.1 System Updates

```bash
apt update && apt upgrade -y
```

### 5.2 Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

Verify:

```bash
node -v   # v20.x.x
npm -v    # 10.x.x
```

### 5.3 Install PM2

```bash
npm install -g pm2
```

### 5.4 Install Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

### 5.5 Install Git

```bash
apt install -y git
```

### 5.6 Create Deploy User

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# Allow deploy to restart Caddy without password
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy, /usr/bin/systemctl restart caddy' > /etc/sudoers.d/deploy-caddy

# Copy SSH key so you can SSH as deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
```

### 5.7 Directory Structure

```bash
mkdir -p /var/www/auth-admin
mkdir -p /opt/apps/auth-api
mkdir -p /opt/repos
chown -R deploy:deploy /var/www /opt/apps /opt/repos
```

### 5.8 Firewall

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

---

## 6. Deploy Auth API

From your local machine, copy the auth-api files to the Droplet:

```bash
scp -r ./auth-api/* deploy@DROPLET_IP:/opt/apps/auth-api/
```

Or clone from GitHub:

```bash
ssh deploy@DROPLET_IP
cd /opt/repos
git clone https://TOKEN@github.com/YOUR_ORG/auth-api.git
cp -r /opt/repos/auth-api/* /opt/apps/auth-api/
```

### 6.1 Create .env

```bash
ssh deploy@DROPLET_IP
cat > /opt/apps/auth-api/.env << 'EOF'
PORT=3100
MONGODB_URI=mongodb+srv://doadmin:PASSWORD@db-mongodb-nyc3-xxxxx.mongo.ondigitalocean.com/?retryWrites=true&w=majority
ADMIN_JWT_SECRET=GENERATE_A_RANDOM_64_CHAR_STRING

# GitHub integration
GITHUB_PAT=github_pat_YOUR_TOKEN
GITHUB_OWNER=your-github-org

# Provisioning (production)
BASE_DOMAIN=seniorverse.dev
CADDY_FILE=/etc/caddy/Caddyfile
STATIC_DIR=/var/www
APPS_DIR=/opt/apps
REPOS_DIR=/opt/repos

# Seed credentials (used only during initial seed)
ADMIN_EMAIL=admin@seniorverse.dev
ADMIN_PASSWORD=YOUR_STRONG_PASSWORD
EOF
```

Generate `ADMIN_JWT_SECRET` with:

```bash
openssl rand -hex 32
```

### 6.2 Install Dependencies

```bash
cd /opt/apps/auth-api
npm install --production
```

### 6.3 Seed Admin User

```bash
cd /opt/apps/auth-api
npm run seed
```

This creates the initial admin user with the email and password from `.env`. You will use these credentials to log into the admin UI.

### 6.4 Start with PM2

```bash
cd /opt/apps/auth-api
pm2 start server.js --name auth-api
pm2 save
pm2 startup
```

Run the command that `pm2 startup` outputs (it will print an `sudo env PATH=...` command).

Verify:

```bash
curl http://localhost:3100/health
# Should return: {"status":"ok"}
```

---

## 7. Deploy Auth Admin UI

From your **local machine**, build the admin UI:

```bash
cd auth-admin
npm install
npm run build
```

Copy the build output to the Droplet:

```bash
scp -r ./auth-admin/dist/* deploy@DROPLET_IP:/var/www/auth-admin/
```

---

## 8. Caddy Configuration

SSH into the Droplet and write the Caddyfile:

```bash
ssh deploy@DROPLET_IP
sudo tee /etc/caddy/Caddyfile > /dev/null << 'CADDYEOF'
auth.seniorverse.dev {
    handle /admin/* {
        reverse_proxy localhost:3100
    }

    handle /verify* {
        reverse_proxy localhost:3100
    }

    handle /webhooks* {
        reverse_proxy localhost:3100
    }

    handle /health {
        reverse_proxy localhost:3100
    }

    handle {
        root * /var/www/auth-admin
        try_files {path} /index.html
        file_server
    }
}
CADDYEOF
```

This routes API paths (`/admin/*`, `/verify`, `/webhooks`, `/health`) to the Express server on port 3100, and serves the static admin UI for everything else (with SPA fallback to `index.html`).

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Caddy automatically provisions a Let's Encrypt TLS certificate for `auth.seniorverse.dev`.

---

## 9. Shared Environment File

Create `/opt/apps/.env.shared` for variables shared across all future apps:

```bash
cat > /opt/apps/.env.shared << 'EOF'
MONGODB_URI=mongodb+srv://doadmin:PASSWORD@db-mongodb-nyc3-xxxxx.mongo.ondigitalocean.com/?retryWrites=true&w=majority
SPACES_REGION=nyc3
SPACES_BUCKET=sv-tools-data
SPACES_KEY=your-spaces-key
SPACES_SECRET=your-spaces-secret
EOF
```

The auth-api doesn't use Spaces directly, but future apps will source this file alongside their own `.env`.

---

## 10. Verify

### Auth API Health Check

```bash
curl https://auth.seniorverse.dev/health
# {"status":"ok"}
```

### Admin UI

1. Open `https://auth.seniorverse.dev` in a browser
2. You should see the admin login page
3. Log in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the seed step
4. You should see the Users and Apps management pages

### Verify Endpoint

```bash
curl -X POST https://auth.seniorverse.dev/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@seniorverse.dev","password":"YOUR_ADMIN_PASSWORD","appId":"test","appSecret":"test"}'
```

This should return a 401 (invalid app secret) since no apps are registered yet. A 401 means the API is running and processing requests. Register an app through the admin UI to fully test `/verify`.

---

## 11. Local Development

### Auth API

```bash
cd auth-api
cp .env.example .env
# Edit .env — set MONGODB_URI and ADMIN_JWT_SECRET at minimum
npm install
npm run seed        # first time only
npm run dev         # starts on http://localhost:3100 with --watch
```

### Auth Admin UI

```bash
cd auth-admin
npm install
npm run dev         # starts on http://localhost:5173
```

Vite proxies `/admin`, `/verify`, and `/webhooks` to `http://localhost:3100` (configured in `vite.config.js`), so the admin UI talks to your local auth API automatically.

### Other Apps (Local)

When running other apps locally, they cannot reach `localhost:3100` for `/verify` since the auth API is on the Droplet. Set `AUTH_URL` in the app's `.env` to the production endpoint:

```
AUTH_URL=https://auth.seniorverse.dev
```

Or run the auth API locally alongside the app.

---

## PM2 Reference

```bash
pm2 list                  # show all processes
pm2 logs auth-api         # tail logs
pm2 restart auth-api      # restart
pm2 stop auth-api         # stop
pm2 delete auth-api       # remove from PM2
pm2 save                  # persist process list across reboots
```

The PM2 ecosystem config is at `config/ecosystem.config.js` for reference, but for the initial deploy you can start processes directly with `pm2 start`.

---

## Adding Future Apps

1. Register the app in the admin UI (Apps > Create) — save the `appSecret`
2. Grant users access (Users > select user > grant access to the app)
3. Deploy the app's API to `/opt/apps/{app-name}-api/` with a `.env` containing:
   ```
   PORT=3101
   DB_NAME={app-name}
   AUTH_URL=http://localhost:3100
   APP_ID={app-slug}
   APP_SECRET=sk_...
   APP_JWT_SECRET=GENERATE_RANDOM_STRING
   ```
4. Deploy static frontend to `/var/www/{app-name}/`
5. Start with PM2: `pm2 start server.js --name {app-name}-api`
6. Add a Caddy block to `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`

Port assignments: auth=3100, model=3101, crm=3102, next app=3103, etc.
