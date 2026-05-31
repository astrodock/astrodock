const { fork } = require('child_process');
const path = require('path');
const Deployment = require('../models/Deployment');

async function runDeploy(app, { trigger = 'manual', commitHash = '', commitMessage = '' } = {}) {
  // Guardrails
  if (!process.env.GITHUB_PAT) {
    throw new Error('GitHub PAT is not configured. Set the GITHUB_PAT environment variable to enable deployments.');
  }

  // Create the deployment record
  const deployment = await Deployment.create({
    appSlug: app.slug,
    trigger,
    commitHash,
    commitMessage,
    status: 'pending',
    startedAt: new Date()
  });

  // Fork the worker process so deploys don't block the auth API
  const workerPath = path.join(__dirname, 'deploy-worker.js');
  const config = JSON.stringify({
    deploymentId: deployment._id.toString(),
    appSlug: app.slug,
    trigger,
    commitHash,
    commitMessage
  });

  const child = fork(workerPath, [config], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();

  return deployment;
}

module.exports = { runDeploy };
