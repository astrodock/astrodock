'use strict';

const crypto = require('crypto');
const config = require('../config');

const GITHUB_API = 'https://api.github.com';

function getHeaders() {
  return {
    Authorization: `Bearer ${config.github.pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function listRepos() {
  const repos = [];
  const endpoints = [
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  ];
  if (config.github.owner) {
    endpoints.push(`/users/${config.github.owner}/repos?per_page=100&sort=updated`);
  }

  for (const endpoint of endpoints) {
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sep = endpoint.includes('?') ? '&' : '?';
      const res = await fetch(`${GITHUB_API}${endpoint}${sep}page=${page}`, { headers: getHeaders() });
      if (!res.ok) break;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) {
        if (!repos.find((e) => e.fullName === r.full_name)) {
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
      config: { url: callbackUrl, content_type: 'json', secret, insecure_ssl: '0' }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
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
  if (!res.ok && res.status !== 404) throw new Error(`Failed to delete webhook: ${res.status}`);
}

function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { listRepos, createWebhook, deleteWebhook, verifyWebhookSignature };
