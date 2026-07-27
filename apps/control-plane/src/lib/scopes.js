'use strict';

// Agent-key permissions. See AUTH_DESIGN.md.
//
// Replaces two coarse scopes (`deploy`, `pages`) where `deploy` reached app
// deletion — which purges databases and object storage — and, where the terminal
// was enabled, arbitrary command execution. A key handed out "just to deploy"
// could destroy data.
//
// The vocabulary is deliberately shared with operator roles, so "what can this
// person do" and "what can this key do" are one concept rather than two.

// ── the scopes ────────────────────────────────────────────────────────────────
const SCOPES = {
  'apps:read': 'View apps, status and health',
  'apps:write': 'Create and configure apps, provision resources, connect repos',
  'apps:delete': 'Delete apps — destroys their database and stored files',
  'deploys:write': 'Deploy, deploy a local build, roll back',
  'runtime:write': 'Restart and stop apps',
  'logs:read': 'Read runtime, build and HTTP access logs',
  'env:read': 'List configuration keys (secret values stay hidden)',
  'env:write': 'Set and remove configuration values',
  'domains:write': 'Add, verify and remove custom domains',
  'pages:read': 'View published pages',
  'pages:write': 'Create, edit and delete pages',
  'users:read': 'View end users and their app access',
  'users:write': 'Create end users and grant or revoke app access',
  'events:read': 'Read the audit trail and sign-in logs',
  'settings:read': 'View platform settings and diagnostics',
  'settings:write': 'Change platform settings and notification rules',
  'backups:write': 'Run and restore backups',
  'platform:write': 'Change the base domain, HTTPS mode and DNS records',
  'tokens:write': 'Create and revoke access keys',
  exec: 'Run commands inside an app'
};

const ALL = Object.keys(SCOPES);

// ── presets ───────────────────────────────────────────────────────────────────
// Nobody hand-picks twenty checkboxes. Note what is absent from every preset:
// `exec`, `tokens:write` and `apps:delete` are always deliberate choices.
const PRESETS = {
  deployer: {
    label: 'Deployer',
    description: 'Build, deploy and configure apps. The usual key for an app to deploy itself.',
    scopes: ['apps:read', 'apps:write', 'deploys:write', 'runtime:write', 'env:read', 'env:write', 'logs:read', 'domains:write']
  },
  operator: {
    label: 'Operator',
    description: 'Everything a deployer can do, plus end users, pages, settings and backups.',
    scopes: ['apps:read', 'apps:write', 'deploys:write', 'runtime:write', 'env:read', 'env:write', 'logs:read',
      'domains:write', 'pages:read', 'pages:write', 'users:read', 'users:write', 'events:read',
      'settings:read', 'settings:write', 'backups:write']
  },
  platform: {
    label: 'Platform manager',
    description: 'Manage the whole platform. Excludes running commands and minting keys.',
    scopes: ALL.filter((s) => s !== 'exec' && s !== 'tokens:write')
  },
  readonly: {
    label: 'Read-only',
    description: 'See everything, change nothing.',
    scopes: ALL.filter((s) => s.endsWith(':read'))
  }
};

// ── legacy ────────────────────────────────────────────────────────────────────
// Tokens issued before this model keep working. `deploy` maps to what it could
// actually do, minus `apps:delete` and `exec` — those were reachable but were
// never what anyone meant by "a deploy key", and silently preserving them would
// carry the original mistake forward forever.
const LEGACY = {
  deploy: PRESETS.deployer.scopes,
  pages: ['pages:read', 'pages:write'],
  '*': ALL.filter((s) => s !== 'exec' && s !== 'tokens:write')
};

function isLegacy(scopes) {
  return (scopes || []).some((s) => Object.prototype.hasOwnProperty.call(LEGACY, s));
}

/** Expand stored scopes (which may be legacy) into the current vocabulary. */
function expand(scopes) {
  const out = new Set();
  for (const s of scopes || []) {
    if (LEGACY[s]) LEGACY[s].forEach((x) => out.add(x));
    else if (SCOPES[s]) out.add(s);
  }
  return [...out];
}

function has(scopes, needed) {
  return expand(scopes).includes(needed);
}

/** Reject unknown scope names outright rather than silently dropping them. */
function validate(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) throw new Error('At least one scope is required.');
  const unknown = scopes.filter((s) => !SCOPES[s] && !LEGACY[s]);
  if (unknown.length) throw new Error(`Unknown scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return expand(scopes);
}

// ── delegation ────────────────────────────────────────────────────────────────
// An agent may mint keys — that is how a platform-managing agent gives a project
// its own deploy key. The constraints make "never the same level or higher"
// structural rather than a rule someone has to remember:
//
//   • the new key's scopes must be a PROPER subset of the minter's
//   • its app scope must be within the minter's
//   • its expiry cannot outlive the minter's
//   • tokens:write is never grantable BY a key, so chains stop at depth one
//
// A human (admin JWT) is not a key and is bound by none of this.
function checkDelegation(minter, requested) {
  if (!minter) return; // a human, acting through the dashboard

  const mine = new Set(expand(minter.scopes));
  const want = expand(requested.scopes);

  if (!mine.has('tokens:write')) {
    throw new Error('This key cannot create other keys (needs the tokens:write scope).');
  }
  if (want.includes('tokens:write')) {
    throw new Error('A key cannot grant tokens:write. Only a person can create a key that makes keys.');
  }

  const excess = want.filter((s) => !mine.has(s));
  if (excess.length) {
    throw new Error(`A key cannot grant permissions it does not hold: ${excess.join(', ')}`);
  }

  // Proper subset: minting a copy of itself would be lateral, not delegated.
  // `tokens:write` is excluded above, so an identical set is impossible anyway —
  // this catches the case where the minter holds nothing else.
  const minterWithout = [...mine].filter((s) => s !== 'tokens:write');
  if (want.length >= minterWithout.length && minterWithout.every((s) => want.includes(s))) {
    throw new Error('A key must grant strictly less than the key creating it.');
  }

  const myApps = minter.appScope || [];
  const wantApps = requested.appScope || [];
  if (myApps.length) {
    if (!wantApps.length) throw new Error('This key is limited to specific apps, so keys it creates must be too.');
    const outside = wantApps.filter((a) => !myApps.includes(a));
    if (outside.length) throw new Error(`Outside this key's apps: ${outside.join(', ')}`);
  }

  if (minter.expiresAt && (!requested.expiresAt || new Date(requested.expiresAt) > new Date(minter.expiresAt))) {
    throw new Error('A key cannot outlive the key that created it.');
  }
}

module.exports = { SCOPES, ALL, PRESETS, LEGACY, expand, has, validate, checkDelegation, isLegacy };
