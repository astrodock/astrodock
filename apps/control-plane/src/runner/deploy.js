'use strict';

const { fork } = require('child_process');
const path = require('path');
const { eq } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { computeMissingRequired } = require('../lib/env-compute');

// Kick off a deploy: validate preconditions + required-variable gate, create a
// Deployment record, then fork the worker (so the API event loop stays free).
// Throws errors with a .status for the route to surface; webhook path logs.
async function runDeploy(app, { trigger = 'manual', commitHash = '', commitMessage = '', localTarball = null } = {}) {
  // A local tarball deploy (CLI `deploy --local`) needs neither a PAT nor a connected repo.
  if (!localTarball) {
    if (!config.github.pat) {
      const e = new Error('GitHub PAT not configured. Set ASTRODOCK_GITHUB_PAT, or use a local deploy.');
      e.status = 422; throw e;
    }
    if (!app.githubRepo) {
      const e = new Error('No GitHub repo connected (or use a local deploy).');
      e.status = 400; throw e;
    }
  }
  if (!app.provisioned) {
    const e = new Error('App must be provisioned before deploying.');
    e.status = 400; throw e;
  }

  // Required-variable gate — record an observable failure and abort before any work.
  const envVars = await db.select().from(schema.appEnvVars).where(eq(schema.appEnvVars.appId, app.id));
  const missing = computeMissingRequired(app, envVars);
  if (missing.length) {
    const lines = missing.map((m) => `  - ${m.key} (${m.reason})`).join('\n');
    const rows = await db.insert(schema.deployments).values({
      appSlug: app.slug, trigger, status: 'failed',
      error: `Missing required variables: ${missing.map((m) => m.key).join(', ')}`,
      log: `Deploy blocked by the required-variable gate.\nMissing:\n${lines}\n`,
      finishedAt: new Date()
    }).returning();
    const e = new Error('Deploy blocked: required variables are missing.');
    e.status = 422; e.missing = missing; e.deployment = rows[0];
    throw e;
  }

  // #6: the partial unique index deployments_one_active_per_app guarantees at most
  // one in-flight deploy per app. A concurrent trigger hits the unique violation.
  let deployment;
  try {
    const rows = await db.insert(schema.deployments).values({
      appSlug: app.slug, trigger, commitHash, commitMessage, status: 'pending', startedAt: new Date()
    }).returning();
    deployment = rows[0];
  } catch (err) {
    if (String(err.message).includes('deployments_one_active_per_app')) {
      const e = new Error('A deploy is already in progress for this app.');
      e.status = 409; throw e;
    }
    throw err;
  }

  const workerPath = path.join(__dirname, 'deploy-worker.js');
  const child = fork(workerPath, [JSON.stringify({ deploymentId: deployment.id, appSlug: app.slug, localTarball })], {
    detached: true, stdio: 'ignore'
  });
  child.unref();

  return deployment;
}

module.exports = { runDeploy };
