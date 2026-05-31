const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const App = require('../models/App');

const BASE_DOMAIN = process.env.BASE_DOMAIN || 'seniorverse.dev';
const CADDY_FILE = process.env.CADDY_FILE || '/etc/caddy/Caddyfile';
const STATIC_DIR = process.env.STATIC_DIR || '/var/www';
const APPS_DIR = process.env.APPS_DIR || '/opt/apps';

function generateCaddyfile(apps) {
  // Auth service block (always present) — matches the deploy script format
  let config = `auth.${BASE_DOMAIN} {
    @api path /admin/* /verify /webhooks/* /health /account /account/*
    handle @api {
        reverse_proxy localhost:${process.env.PORT || 3100}
    }
    handle {
        root * /var/www/auth-admin
        try_files {path} /index.html
        file_server
    }
}\n`;

  for (const app of apps) {
    config += `
${app.subdomain}.${BASE_DOMAIN} {
    @api path /api/*
    handle @api {
        reverse_proxy localhost:${app.port}
    }
    handle {
        root * ${STATIC_DIR}/${app.slug}
        try_files {path} /index.html
        file_server
    }
}\n`;
  }

  return config;
}

async function provisionApp(app) {
  // Guardrail: verify base directories exist or can be created
  for (const [label, dir] of [['STATIC_DIR', STATIC_DIR], ['APPS_DIR', APPS_DIR]]) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new Error(
          `Provisioning is not available in this environment. ` +
          `${label} ("${dir}") does not exist and could not be created: ${err.message}. ` +
          `Set STATIC_DIR and APPS_DIR to valid paths.`
        );
      }
    }
  }

  const results = [];

  // 1. Create static files directory
  const staticPath = path.join(STATIC_DIR, app.slug);
  if (!fs.existsSync(staticPath)) {
    fs.mkdirSync(staticPath, { recursive: true });
    results.push(`Created ${staticPath}`);
  } else {
    results.push(`${staticPath} already exists`);
  }

  // 2. Create API directory
  const apiPath = path.join(APPS_DIR, `${app.slug}-api`);
  if (!fs.existsSync(apiPath)) {
    fs.mkdirSync(apiPath, { recursive: true });
    results.push(`Created ${apiPath}`);
  } else {
    results.push(`${apiPath} already exists`);
  }

  // 3. Write .env file for the app from stored env vars
  const envPath = path.join(apiPath, '.env');
  if (!fs.existsSync(envPath)) {
    const envVars = app.getRawEnvVars ? app.getRawEnvVars() : app.envVars;
    const envContent = envVars
      .map(v => `${v.key}=${v.value}`)
      .join('\n') + '\n';
    fs.writeFileSync(envPath, envContent);
    results.push(`Created ${envPath}`);
  } else {
    results.push(`${envPath} already exists — skipped`);
  }

  // 4. Regenerate Caddyfile from all provisioned apps
  const allApps = await App.find({ isProvisioned: true });
  // Include the app being provisioned even if not yet marked
  if (!allApps.find(a => a.slug === app.slug)) {
    allApps.push(app);
  }
  const caddyConfig = generateCaddyfile(allApps);

  fs.writeFileSync(CADDY_FILE, caddyConfig);
  results.push(`Updated ${CADDY_FILE}`);

  // 5. Reload Caddy
  try {
    execSync('sudo caddy reload --config ' + CADDY_FILE, { timeout: 10000 });
    results.push('Caddy reloaded');
  } catch (err) {
    results.push(`Caddy reload failed: ${err.message}. You may need to reload manually.`);
  }

  return results;
}

async function unprovisionApp(app) {
  // Regenerate Caddyfile without this app
  const remainingApps = await App.find({ isProvisioned: true, slug: { $ne: app.slug } });
  const caddyConfig = generateCaddyfile(remainingApps);

  try {
    fs.writeFileSync(CADDY_FILE, caddyConfig);
  } catch { /* best effort */ }

  try {
    execSync('sudo caddy reload --config ' + CADDY_FILE, { timeout: 10000 });
  } catch {
    // Non-fatal — admin can reload manually
  }
}

module.exports = { provisionApp, unprovisionApp, generateCaddyfile };
