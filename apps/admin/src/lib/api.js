const API_BASE = '/admin';
export const TOKEN_KEY = 'astrodock_token';

let token = sessionStorage.getItem(TOKEN_KEY);

export function setToken(t) {
  token = t;
  sessionStorage.setItem(TOKEN_KEY, t);
}

export function getToken() {
  return token;
}

export function clearToken() {
  token = null;
  sessionStorage.removeItem(TOKEN_KEY);
}

// Error subclass that preserves the structured body (status + JSON payload)
// so callers can react to e.g. the 422 missing-required-vars deploy response.
export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body || {};
  }
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // A 401 usually means the session is gone, so bounce to sign-in. But endpoints
  // that CHECK a credential answer 401 for "wrong password" — treating that the
  // same way logged people out for a typo, which is what made re-authentication
  // look broken. Those pass verifiesCredential and get a normal error instead.
  if (res.status === 401 && path !== '/login' && !options.verifiesCredential) {
    clearToken();
    window.location.href = '/login';
    throw new ApiError('Session expired', { status: 401 });
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || 'Request failed', { status: res.status, body: data });
  }
  return data;
}

// Auth
export const login = (email, password, extra = {}) =>
  request('/login', { method: 'POST', body: JSON.stringify({ email, password, ...extra }) });

// ── First-run setup ───────────────────────────────────────────────────────────
// Lives outside /admin: /setup/status has to answer before an admin exists, and
// before the platform has a domain at all (it is served over http://<server-ip>).
async function setupRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/setup${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Request failed', { status: res.status, body: data });
  return data;
}

export const getSetupStatus = () => setupRequest('/status');
export const claimAdmin = (token_, email, password, name) =>
  setupRequest('/claim', { method: 'POST', body: JSON.stringify({ token: token_, email, password, name }) });
export const checkSetupDns = (baseDomain, observedIp) =>
  setupRequest('/check-dns', { method: 'POST', body: JSON.stringify({ baseDomain, observedIp }) });
export const deferSetupDomain = () => setupRequest('/defer', { method: 'POST' });
export const exchangeHandoff = (nonce) =>
  setupRequest('/handoff', { method: 'POST', body: JSON.stringify({ nonce }) });
export const getDnsProviders = () => setupRequest('/dns/providers');
export const createDnsRecord = (provider, token, baseDomain, observedIp) =>
  setupRequest('/dns/create', { method: 'POST', body: JSON.stringify({ provider, token, baseDomain, observedIp }) });
export const setSetupDomain = (baseDomain, tlsMode, acmeEmail) =>
  setupRequest('/domain', { method: 'POST', body: JSON.stringify({ baseDomain, tlsMode, acmeEmail }) });

// Users
export const getUsers = () => request('/users');
export const getUser = (id) => request(`/users/${id}`);
export const createUser = (data) =>
  request('/users', { method: 'POST', body: JSON.stringify(data) });
export const updateUser = (id, data) =>
  request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteUser = (id) =>
  request(`/users/${id}`, { method: 'DELETE' });
export const resetPassword = (id, newPassword) =>
  request(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
export const grantAccess = (userId, appSlug) =>
  request(`/users/${userId}/access/${appSlug}`, { method: 'PUT' });
export const revokeAccess = (userId, appSlug) =>
  request(`/users/${userId}/access/${appSlug}`, { method: 'DELETE' });

// Apps
export const getApps = () => request('/apps');
export const getApp = (slug) => request(`/apps/${slug}`);
export const createApp = (data) =>
  request('/apps', { method: 'POST', body: JSON.stringify(data) });
export const updateApp = (slug, data) =>
  request(`/apps/${slug}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteApp = (slug) =>
  request(`/apps/${slug}`, { method: 'DELETE' });
export const rotateSecret = (slug) =>
  request(`/apps/${slug}/rotate-secret`, { method: 'POST' });
export const provisionApp = (slug) =>
  request(`/apps/${slug}/provision`, { method: 'POST' });

// GitHub
export const getGithubRepos = () => request('/apps/github/repos');
export const connectRepo = (slug, githubRepo, branch, repoPath) =>
  request(`/apps/${slug}/connect-repo`, { method: 'POST', body: JSON.stringify({ githubRepo, branch, repoPath }) });
export const disconnectRepo = (slug) =>
  request(`/apps/${slug}/disconnect-repo`, { method: 'POST' });

// Deploys
export const triggerDeploy = (slug) =>
  request(`/apps/${slug}/deploy`, { method: 'POST' });
export const rollbackApp = (slug) =>
  request(`/apps/${slug}/rollback`, { method: 'POST' });

// Custom domains
export const getAllDomains = () => request('/domains');
export const getDomains = (slug) => request(`/apps/${slug}/domains`);
export const addDomain = (slug, hostname) =>
  request(`/apps/${slug}/domains`, { method: 'POST', body: JSON.stringify({ hostname }) });
export const verifyDomain = (slug, id) =>
  request(`/apps/${slug}/domains/${id}/verify`, { method: 'POST' });
export const updateDomain = (slug, id, data) =>
  request(`/apps/${slug}/domains/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteDomain = (slug, id) =>
  request(`/apps/${slug}/domains/${id}`, { method: 'DELETE' });
export const getDeployments = (slug) =>
  request(`/apps/${slug}/deployments`);
export const getDeployment = (slug, id) =>
  request(`/apps/${slug}/deployments/${id}`);

// Env Vars
export const getEnvVars = (slug) => request(`/apps/${slug}/env`);
export const setEnvVar = (slug, key, value) =>
  request(`/apps/${slug}/env/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
export const deleteEnvVar = (slug, key) =>
  request(`/apps/${slug}/env/${key}`, { method: 'DELETE' });
export const bulkImportEnv = (slug, raw) =>
  request(`/apps/${slug}/env/bulk`, { method: 'POST', body: JSON.stringify({ raw }) });

// Process management
export const getAllAppStatuses = () => request('/apps/status/all');
export const getAppStatus = (slug) => request(`/apps/${slug}/status`);
export const restartApp = (slug) =>
  request(`/apps/${slug}/restart`, { method: 'POST' });
export const stopApp = (slug) =>
  request(`/apps/${slug}/stop`, { method: 'POST' });

// Logs
export const getAppLogs = (slug, lines = 100) =>
  request(`/apps/${slug}/logs?lines=${lines}`);

// Your own account: factors, sessions, step-up
export const getAccount = () => request('/account');
export const reauth = (proof) =>
  request('/account/reauth', { method: 'POST', body: JSON.stringify(proof), verifiesCredential: true });
export const setPassword = (password, currentPassword) =>
  request('/account/password', { method: 'PUT', body: JSON.stringify({ password, currentPassword }) });
export const removePassword = () => request('/account/password', { method: 'DELETE' });
export const passkeyOptions = () => request('/account/passkeys/options', { method: 'POST' });
// Step-up: which factors this account can prove itself with, and the passkey challenge.
export const reauthOptions = () => request('/account/reauth/options');
export const reauthPasskeyOptions = () =>
  request('/account/reauth/passkey/options', { method: 'POST' });
export const passkeyRegister = (body) => request('/account/passkeys', { method: 'POST', body: JSON.stringify(body) });
export const passkeyRemove = (id) => request(`/account/passkeys/${id}`, { method: 'DELETE' });
export const totpBegin = () => request('/account/totp/begin', { method: 'POST' });
export const totpConfirm = (code) => request('/account/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
export const totpRemove = () => request('/account/totp', { method: 'DELETE' });
export const generateRecoveryCodes = () => request('/account/recovery-codes', { method: 'POST' });
export const revokeSession = (id) => request(`/account/sessions/${id}`, { method: 'DELETE' });
export const revokeOtherSessions = () => request('/account/sessions/revoke-others', { method: 'POST' });

// Access keys: what this caller may hand out
export const getTokenOptions = () => request('/tokens/options');

// Hosted-login callbacks (exact-match allowlist per app)
export const getRedirectUris = (slug) => request(`/apps/${slug}/redirect-uris`);
export const addRedirectUri = (slug, uri) =>
  request(`/apps/${slug}/redirect-uris`, { method: 'POST', body: JSON.stringify({ uri }) });
export const removeRedirectUri = (slug, id) =>
  request(`/apps/${slug}/redirect-uris/${id}`, { method: 'DELETE' });

// Structured operations on a deployed app (replaces the removed terminal)
export const opsList = (slug, path) => request(`/apps/${slug}/ops/list?path=${encodeURIComponent(path || '.')}`);
export const opsFile = (slug, path) => request(`/apps/${slug}/ops/file?path=${encodeURIComponent(path)}`);
export const opsEnv = (slug) => request(`/apps/${slug}/ops/env`);
export const opsCommands = (slug) => request(`/apps/${slug}/ops/commands`);
export const opsRun = (slug, name) =>
  request(`/apps/${slug}/ops/run`, { method: 'POST', body: JSON.stringify({ name }) });

// Health
export const getHealth = () => request('/health');
export const getPlatformHealth = () => request('/health/platform');

// Activity
export const getRecentDeployments = (limit = 50) =>
  request(`/activity/deployments?limit=${limit}`);
export const getAuthLogs = ({ limit = 50, result, appId, email } = {}) => {
  const params = new URLSearchParams();
  params.set('limit', limit);
  if (result) params.set('result', result);
  if (appId) params.set('appId', appId);
  if (email) params.set('email', email);
  return request(`/activity/auth-logs?${params}`);
};

// Audit / system events
export const getEvents = ({ limit = 100, category, appSlug } = {}) => {
  const p = new URLSearchParams();
  p.set('limit', limit);
  if (category) p.set('category', category);
  if (appSlug) p.set('appSlug', appSlug);
  return request(`/activity/events?${p}`);
};

// App HTTP access logs (opt-in Caddy logs)
export const getAppAccessLogs = (slug) => request(`/apps/${slug}/access-logs`);

// Backups
export const getBackups = () => request('/backups');
export const runBackup = () => request('/backups', { method: 'POST' });
export const restoreBackup = (id) =>
  request(`/backups/${id}/restore`, { method: 'POST' });

// Downloads bypass request(): the body is a gzip stream, not JSON, and it has to
// reach the browser as a file rather than a parsed object.
export async function downloadBackup(id) {
  const res = await fetch(`${API_BASE}/backups/${id}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try { message = (await res.json()).error || message; } catch { /* keep the default */ }
    throw new ApiError(message, { status: res.status });
  }
  const disposition = res.headers.get('content-disposition') || '';
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] || `astrodock-backup-${id}.sql.gz`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return name;
}

export async function uploadBackup(file) {
  const res = await fetch(`${API_BASE}/backups/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `Upload failed (${res.status})`, { status: res.status, body });
  return body;
}

// API Tokens (scoped tokens for the CLI / agents)
export const getTokens = () => request('/tokens');
// Takes the whole request now: preset OR explicit scopes, app scope, expiry.
export const createToken = (body) => request('/tokens', { method: 'POST', body: JSON.stringify(body) });
export const deleteToken = (id) =>
  request(`/tokens/${id}`, { method: 'DELETE' });

// Platform settings (operational overrides + read-only diagnostics + readiness)
export const getSettings = () => request('/settings');
// Cached server-side; force=1 is the "Check now" button.
export const getVersion = (force) => request(`/settings/version${force ? '?force=1' : ''}`);
export const updateSettings = (updates) =>
  request('/settings', { method: 'PATCH', body: JSON.stringify({ updates }) });

// Email delivery. Separate from the settings PATCH because it carries credentials:
// they are written encrypted and never read back, so the UI only ever learns
// whether a credential is set, not what it is.
export const getEmailConfig = () => request('/settings/email');
export const updateEmailConfig = (data) =>
  request('/settings/email', { method: 'PUT', body: JSON.stringify(data) });
export const sendTestEmail = (to) =>
  request('/settings/email/test', { method: 'POST', body: JSON.stringify({ to }) });

// Notification rules + delivery log
export const getNotificationRules = () => request('/notifications');
export const createNotificationRule = (data) =>
  request('/notifications', { method: 'POST', body: JSON.stringify(data) });
export const updateNotificationRule = (id, data) =>
  request(`/notifications/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteNotificationRule = (id) =>
  request(`/notifications/${id}`, { method: 'DELETE' });
export const testNotification = (data) =>
  request('/notifications/test', { method: 'POST', body: JSON.stringify(data) });
export const getNotificationDeliveries = () => request('/notifications/deliveries');

// Pages (lightweight hosted documents / mini-sites)
export const getPages = () => request('/pages');
export const getPage = (pageId) => request(`/pages/${pageId}`);
export const createPage = (data) =>
  request('/pages', { method: 'POST', body: JSON.stringify(data) });
export const updatePage = (pageId, data) =>
  request(`/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const reissuePageId = (pageId) =>
  request(`/pages/${pageId}/reissue-id`, { method: 'POST' });
export const deletePage = (pageId) =>
  request(`/pages/${pageId}`, { method: 'DELETE' });
export const generatePagePasskey = (pageId) =>
  request(`/pages/${pageId}/generate-passkey`, { method: 'POST' });
export const getPageViews = (pageId) => request(`/pages/${pageId}/views`);
export const getPageFileContent = (pageId, p) =>
  request(`/pages/${pageId}/file?path=${encodeURIComponent(p)}`);
export const savePageFileContent = (pageId, p, content) =>
  request(`/pages/${pageId}/file`, { method: 'PUT', body: JSON.stringify({ path: p, content }) });
export const deletePageFile = (pageId, p) =>
  request(`/pages/${pageId}/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });

// multipart upload (fetch sets the boundary; don't set Content-Type)
export async function uploadPageFiles(pageId, fileList, paths) {
  const form = new FormData();
  for (const f of fileList) form.append('files', f, f.name);
  form.append('paths', JSON.stringify(paths));
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/pages/${pageId}/files`, { method: 'POST', headers, body: form });
  if (res.status === 401) { clearToken(); window.location.href = '/login'; throw new ApiError('Session expired', { status: 401 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload failed', { status: res.status, body: data });
  return data;
}
