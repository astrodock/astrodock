'use strict';

// Operator roles — who may use the dashboard, and to what extent.
//
// Deliberately expressed in the SAME vocabulary as agent-key scopes (lib/scopes),
// so authorization is one question with one answer rather than two parallel
// systems that drift. A route asks "does this caller hold env:write"; whether the
// caller is a person or a key is not its concern.
//
// Distinct from `app_access`, which says which APPS a person may sign in to. The
// two are independent: an owner with no app_access cannot sign into an app, and an
// end user with app_access has no dashboard at all. See AUTH_DESIGN.md.

const { ALL } = require('./scopes');

const ROLES = {
  owner: {
    label: 'Owner',
    description: 'Full control, including ownership and access keys. Cannot be locked out.',
    scopes: ALL
  },
  admin: {
    label: 'Admin',
    description: 'Everything except transferring ownership.',
    scopes: ALL
  },
  operator: {
    label: 'Operator',
    description: 'Apps, deploys, configuration, runtime and logs. No user or key management.',
    scopes: ALL.filter((s) => !['users:write', 'tokens:write', 'platform:write', 'settings:write', 'apps:delete', 'exec']
      .includes(s))
  },
  viewer: {
    label: 'Viewer',
    // The audit trail is included on purpose: it is how an operator understands
    // their own platform, and withholding it would make the role near-useless
    // while protecting nothing a viewer cannot infer from apps and deploys.
    description: 'Read-only, including the audit trail.',
    scopes: ALL.filter((s) => s.endsWith(':read'))
  }
};

const ORDER = ['viewer', 'operator', 'admin', 'owner'];

function isOperator(user) {
  return !!(user && user.operatorRole && ROLES[user.operatorRole]);
}

function scopesFor(role) {
  return (ROLES[role] && ROLES[role].scopes) || [];
}

function rank(role) {
  const i = ORDER.indexOf(role);
  return i === -1 ? -1 : i;
}

/** Can `actor` modify `target`'s account? Ownership is the line that matters. */
function canManageUser(actor, target) {
  if (!actor) return { ok: false, reason: 'Not signed in.' };
  // Only an owner may touch an owner — including demoting one.
  if (target.operatorRole === 'owner' && actor.role !== 'owner') {
    return { ok: false, reason: 'Only an owner can change another owner.' };
  }
  // Managing operators at all requires being at least an admin.
  if (target.operatorRole && rank(actor.role) < rank('admin')) {
    return { ok: false, reason: 'Only admins and owners can manage operator accounts.' };
  }
  return { ok: true };
}

/**
 * Agent keys may manage END USERS, never operators — and never the human whose
 * authority the key is acting under, so a key cannot be used to alter or lock out
 * its own principal. See AUTH_DESIGN.md.
 */
function keyCanManageUser(auth, target) {
  if (target.operatorRole) {
    return { ok: false, reason: 'Access keys cannot manage operator accounts, only end users.' };
  }
  if (auth.authorizedByUserId && target.id === auth.authorizedByUserId) {
    return { ok: false, reason: 'An access key cannot modify the account it is authorised under.' };
  }
  return { ok: true };
}

module.exports = { ROLES, ORDER, isOperator, scopesFor, rank, canManageUser, keyCanManageUser };
