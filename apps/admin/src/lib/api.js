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

  if (res.status === 401 && path !== '/login') {
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
export const login = (email, password) =>
  request('/login', { method: 'POST', body: JSON.stringify({ email, password }) });

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

// Health
export const getHealth = () => request('/health');

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

// API Tokens (scoped tokens for the CLI / agents)
export const getTokens = () => request('/tokens');
export const createToken = (name, scopes = ['deploy']) =>
  request('/tokens', { method: 'POST', body: JSON.stringify({ name, scopes }) });
export const deleteToken = (id) =>
  request(`/tokens/${id}`, { method: 'DELETE' });

// Platform settings (operational overrides + read-only diagnostics + readiness)
export const getSettings = () => request('/settings');
export const updateSettings = (updates) =>
  request('/settings', { method: 'PATCH', body: JSON.stringify({ updates }) });

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
