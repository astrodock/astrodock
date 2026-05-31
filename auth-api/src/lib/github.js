const crypto = require('crypto');

const GITHUB_API = 'https://api.github.com';

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function listRepos() {
  const repos = [];

  // Try multiple sources to find repos the PAT can access

  // 1. Repos accessible to the authenticated user (works for classic PATs)
  const endpoints = [
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  ];

  // 2. If GITHUB_OWNER is set, also search by owner (works for fine-grained PATs scoped to an org/user)
  if (process.env.GITHUB_OWNER) {
    endpoints.push(`/users/${process.env.GITHUB_OWNER}/repos?per_page=100&sort=updated`);
  }

  // 3. Also try listing installations for fine-grained PATs
  for (const endpoint of endpoints) {
    let page = 1;
    while (true) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const url = `${GITHUB_API}${endpoint}${separator}page=${page}`;
      const res = await fetch(url, { headers: getHeaders() });

      if (!res.ok) {
        console.log(`GitHub API ${endpoint} returned ${res.status}`);
        break;
      }

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const r of data) {
        if (!repos.find(existing => existing.fullName === r.full_name)) {
          repos.push({ fullName: r.full_name, name: r.name, private: r.private });
        }
      }
      page++;
    }
  }

  return repos;
}

async function createWebhook(repo, callbackUrl, secret) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/hooks`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: callbackUrl,
        content_type: 'json',
        secret: secret,
        insecure_ssl: '0'
      }
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Failed to create webhook: ${res.status}`);
  }

  const data = await res.json();
  return data.id;
}

async function deleteWebhook(repo, webhookId) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/hooks/${webhookId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete webhook: ${res.status}`);
  }
}

function verifyWebhookSignature(payload, signature, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { listRepos, createWebhook, deleteWebhook, verifyWebhookSignature, generateWebhookSecret };
