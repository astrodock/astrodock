#!/usr/bin/env node

// This script runs in a forked child process so deploys don't block the auth API.
// It receives deploy config via process.argv and saves progress to MongoDB.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Deployment = require('../models/Deployment');
const App = require('../models/App');

const STATIC_DIR = process.env.STATIC_DIR || '/var/www';
const APPS_DIR = process.env.APPS_DIR || '/opt/apps';
const REPOS_DIR = process.env.REPOS_DIR || '/opt/repos';

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 300000, ...opts }).trim();
}

async function run() {
  const config = JSON.parse(process.argv[2]);
  const { deploymentId, appSlug, trigger, commitHash: initialCommitHash, commitMessage: initialCommitMessage } = config;

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'auth' });

  const deployment = await Deployment.findById(deploymentId);
  const app = await App.findOne({ slug: appSlug });

  if (!deployment || !app) {
    console.error('Deployment or app not found');
    process.exit(1);
  }

  let commitHash = initialCommitHash;
  let commitMessage = initialCommitMessage;
  let log = '';

  async function appendLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    log += line;
    // Save log incrementally so the UI can show progress
    await Deployment.updateOne({ _id: deploymentId }, { log });
  }

  async function updateStatus(status) {
    deployment.status = status;
    await Deployment.updateOne({ _id: deploymentId }, { status, log });
  }

  try {
    const repoDir = path.join(REPOS_DIR, app.slug);
    const staticPath = path.join(STATIC_DIR, app.slug);
    const apiPath = path.join(APPS_DIR, `${app.slug}-api`);
    const repoUrl = `https://x-access-token:${process.env.GITHUB_PAT}@github.com/${app.githubRepo}.git`;

    // 1. Clone or pull
    await updateStatus('cloning');

    if (!fs.existsSync(REPOS_DIR)) {
      fs.mkdirSync(REPOS_DIR, { recursive: true });
    }

    if (fs.existsSync(path.join(repoDir, '.git'))) {
      await appendLog(`Pulling latest from ${app.githubRepo} (${app.branch})`);
      const pullOutput = exec(`git -C "${repoDir}" fetch origin && git -C "${repoDir}" reset --hard origin/${app.branch}`);
      await appendLog(pullOutput || 'Pull complete');
    } else {
      await appendLog(`Cloning ${app.githubRepo} (${app.branch})`);
      const cloneOutput = exec(`git clone --branch ${app.branch} --single-branch "${repoUrl}" "${repoDir}"`);
      await appendLog(cloneOutput || 'Clone complete');
    }

    // Get commit info
    if (!commitHash) {
      commitHash = exec(`git -C "${repoDir}" rev-parse --short HEAD`);
    }
    if (!commitMessage) {
      commitMessage = exec(`git -C "${repoDir}" log -1 --pretty=%s`);
    }
    await Deployment.updateOne({ _id: deploymentId }, { commitHash, commitMessage });
    await appendLog(`Commit: ${commitHash} — ${commitMessage}`);

    // 2. Build
    await updateStatus('building');

    const deployRoot = app.repoPath ? path.join(repoDir, app.repoPath) : repoDir;
    if (app.repoPath) {
      await appendLog(`Using repo path: ${app.repoPath}`);
      if (!fs.existsSync(deployRoot)) {
        throw new Error(`Repo path "${app.repoPath}" does not exist in the repository`);
      }
    }

    const hasAppDir = fs.existsSync(path.join(deployRoot, 'app'));
    const hasServerDir = fs.existsSync(path.join(deployRoot, 'server'));
    const isStandaloneServer = !hasServerDir && !hasAppDir && fs.existsSync(path.join(deployRoot, 'server.js'));
    const isStandaloneApp = !hasServerDir && !hasAppDir && fs.existsSync(path.join(deployRoot, 'package.json')) && !isStandaloneServer;

    const appSrc = hasAppDir ? path.join(deployRoot, 'app') : (isStandaloneApp ? deployRoot : null);
    const serverSrc = hasServerDir ? path.join(deployRoot, 'server') : (isStandaloneServer ? deployRoot : null);

    if (!appSrc && !serverSrc) {
      await appendLog('WARNING: No deployable structure found. Expected app/ and/or server/ directories, or a standalone server.js.');
    }

    if (appSrc) {
      await appendLog('Installing frontend dependencies...');
      const npmOut = exec(`cd "${appSrc}" && npm ci 2>&1`);
      await appendLog(npmOut || 'Dependencies installed');

      await appendLog(`Building frontend (${app.buildCommand})...`);
      const buildOut = exec(`cd "${appSrc}" && ${app.buildCommand} 2>&1`);
      await appendLog(buildOut || 'Build complete');
    }

    if (serverSrc) {
      await appendLog('Installing server dependencies...');
      const npmOut = exec(`cd "${serverSrc}" && npm ci --production 2>&1`);
      await appendLog(npmOut || 'Server dependencies installed');
    }

    // 3. Deploy files
    await updateStatus('deploying');

    if (appSrc) {
      const distDir = path.join(appSrc, 'dist');
      if (fs.existsSync(distDir)) {
        fs.mkdirSync(staticPath, { recursive: true });
        await appendLog(`Copying frontend build to ${staticPath}`);
        exec(`rsync -a --delete "${distDir}/" "${staticPath}/"`);
      } else {
        await appendLog('WARNING: No dist/ directory found after build');
      }
    }

    if (serverSrc) {
      fs.mkdirSync(apiPath, { recursive: true });
      await appendLog(`Copying server to ${apiPath}`);
      exec(`rsync -a --delete --exclude='.env' --exclude='node_modules' "${serverSrc}/" "${apiPath}/"`);
      await appendLog('Installing production dependencies in deploy target...');
      const prodOut = exec(`cd "${apiPath}" && npm ci --production 2>&1`);
      await appendLog(prodOut || 'Production dependencies installed');
    }

    // 4. Write .env
    if (serverSrc) {
      await appendLog('Writing environment variables...');
      const envContent = app.envVars
        .map(v => `${v.key}=${v.value}`)
        .join('\n') + '\n';
      fs.writeFileSync(path.join(apiPath, '.env'), envContent);
      await appendLog(`Wrote ${app.envVars.length} env vars`);
    }

    // 5. Restart PM2
    if (serverSrc) {
      const pmName = `${app.slug}-api`;
      await appendLog(`Restarting PM2 process: ${pmName}`);

      try { exec(`pm2 stop ${pmName} 2>&1`); } catch {}
      try { exec(`pm2 delete ${pmName} 2>&1`); } catch {}
      try { exec(`kill $(lsof -t -i:${app.port}) 2>/dev/null`); } catch {}

      // Wait for port to be free
      for (let i = 0; i < 10; i++) {
        try {
          exec(`lsof -i:${app.port} -t 2>/dev/null`);
          exec('sleep 0.5');
        } catch {
          break;
        }
      }

      // Write a PM2 ecosystem file with explicit env vars.
      // PM2 merges ecosystem env with the inherited process env, so we must
      // explicitly blank out auth-api secrets to prevent leaking, and ensure
      // MONGODB_URI is always set so apps never inherit the auth database.
      const envObj = {};
      for (const v of app.envVars) {
        envObj[v.key] = v.value;
      }

      // Prevent auth-api secrets from leaking to app processes
      const SANITIZE_KEYS = [
        'ADMIN_JWT_SECRET', 'GITHUB_PAT', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
        'CADDY_FILE', 'STATIC_DIR', 'APPS_DIR', 'REPOS_DIR'
      ];
      for (const key of SANITIZE_KEYS) {
        if (!(key in envObj)) envObj[key] = '';
      }
      // Always set MONGODB_URI explicitly — never let apps inherit the auth DB
      if (!envObj.MONGODB_URI) envObj.MONGODB_URI = '';
      const ecosystemConfig = {
        apps: [{
          name: pmName,
          script: 'server.js',
          cwd: apiPath,
          log_date_format: 'YYYY-MM-DD HH:mm:ss',
          env: envObj
        }]
      };
      // Use .cjs extension for ESM projects so Node doesn't reject the CommonJS syntax
      const appPkg = JSON.parse(fs.readFileSync(path.join(apiPath, 'package.json'), 'utf8'));
      const ecosystemExt = appPkg.type === 'module' ? '.cjs' : '.js';
      const ecosystemPath = path.join(apiPath, `ecosystem.config${ecosystemExt}`);
      fs.writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify(ecosystemConfig, null, 2)};\n`);

      const startOut = exec(`pm2 start "${ecosystemPath}" 2>&1`);
      await appendLog(startOut || 'PM2 process started');
      exec('pm2 save 2>&1');

      // Deploy marker in app logs
      const homeDir = process.env.HOME || '/home/deploy';
      const logFile = `${homeDir}/.pm2/logs/${pmName}-out.log`;
      const marker = `\n════ Deployed ${commitHash || 'latest'} at ${new Date().toISOString()} ════\n`;
      try { fs.appendFileSync(logFile, marker); } catch {}
    }

    // Success
    await appendLog('Deploy complete');
    await Deployment.updateOne({ _id: deploymentId }, {
      status: 'success',
      log,
      commitHash,
      commitMessage,
      finishedAt: new Date()
    });

  } catch (err) {
    await appendLog(`ERROR: ${err.message}`);
    if (err.stderr) await appendLog(err.stderr);
    if (err.stdout) await appendLog(err.stdout);

    await Deployment.updateOne({ _id: deploymentId }, {
      status: 'failed',
      error: err.message,
      log,
      finishedAt: new Date()
    });
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Deploy worker crashed:', err);
  process.exit(1);
});
