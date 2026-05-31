import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost } from '../lib/appUrl';

export default function SettingsTab({ app, onRefresh }) {
  const navigate = useNavigate();

  // Resource / runtime config
  const [authMode, setAuthMode] = useState(app.auth?.mode || 'platform');
  const [databaseMode, setDatabaseMode] = useState(app.database?.mode || 'none');
  const [storageMode, setStorageMode] = useState(app.storage?.mode || 'none');
  const [runtimeType, setRuntimeType] = useState(app.runtime?.type || 'node');
  const [buildCommand, setBuildCommand] = useState(app.runtime?.buildCommand || '');
  const [dockerfile, setDockerfile] = useState(app.runtime?.dockerfile || '');
  const [savingConfig, setSavingConfig] = useState(false);

  // Repo connection
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(app.source?.githubRepo || '');
  const [branch, setBranch] = useState(app.source?.branch || 'main');
  const [repoPath, setRepoPath] = useState(app.source?.repoPath || '');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [provisionResult, setProvisionResult] = useState(null);
  const [newSecret, setNewSecret] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Keep local form state in sync if the app reloads
  useEffect(() => {
    setAuthMode(app.auth?.mode || 'platform');
    setDatabaseMode(app.database?.mode || 'none');
    setStorageMode(app.storage?.mode || 'none');
    setRuntimeType(app.runtime?.type || 'node');
    setBuildCommand(app.runtime?.buildCommand || '');
    setDockerfile(app.runtime?.dockerfile || '');
    setSelectedRepo(app.source?.githubRepo || '');
    setBranch(app.source?.branch || 'main');
    setRepoPath(app.source?.repoPath || '');
  }, [app]);

  async function loadRepos() {
    setLoadingRepos(true);
    try {
      const data = await api.getGithubRepos();
      setRepos(data.repos);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingRepos(false);
    }
  }

  async function handleSaveConfig(e) {
    e.preventDefault();
    setSavingConfig(true);
    setError('');
    setSuccess('');
    try {
      await api.updateApp(app.slug, {
        authMode,
        databaseMode,
        storageMode,
        runtimeType,
        buildCommand,
        dockerfile
      });
      setSuccess('Configuration saved. Re-provision and redeploy to apply.');
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleConnect(e) {
    e.preventDefault();
    if (!selectedRepo) return;
    setConnecting(true);
    setError('');
    setSuccess('');
    try {
      await api.connectRepo(app.slug, selectedRepo, branch, repoPath);
      setSuccess(`Connected to ${selectedRepo} (${branch})`);
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect this repository? Automatic deploys will stop.')) return;
    setError('');
    try {
      await api.disconnectRepo(app.slug);
      setSelectedRepo('');
      setSuccess('Repository disconnected');
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRotateSecret() {
    if (!confirm('Rotate the app secret? The current secret will stop working immediately. You will need to redeploy the app.')) return;
    setError('');
    setNewSecret(null);
    try {
      const data = await api.rotateSecret(app.slug);
      setNewSecret(data.appSecret);
      setSuccess(data.note || 'App secret rotated. Redeploy to apply.');
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleProvision() {
    if (!confirm(`Provision "${app.name}"? This creates internal resources and updates routing.`)) return;
    setError('');
    setProvisionResult(null);
    try {
      const data = await api.provisionApp(app.slug);
      setProvisionResult(data);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${app.name}"? This will remove the app, all deployments, and routing. This cannot be undone.`)) return;
    try {
      await api.deleteApp(app.slug);
      navigate('/apps');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="tab-header">
        <h2>Settings</h2>
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Resources & Runtime */}
      <section className="settings-section">
        <h3>Resources & Runtime</h3>
        <form onSubmit={handleSaveConfig}>
          <div className="form-row">
            <label>
              Authentication
              <select value={authMode} onChange={e => setAuthMode(e.target.value)}>
                <option value="platform">Platform-managed</option>
                <option value="public">Public (no auth)</option>
              </select>
            </label>
            <label>
              Runtime
              <select value={runtimeType} onChange={e => setRuntimeType(e.target.value)}>
                <option value="node">Node buildpack</option>
                <option value="docker">Dockerfile</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Database
              <select value={databaseMode} onChange={e => setDatabaseMode(e.target.value)}>
                <option value="internal">Internal</option>
                <option value="external">External</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>
              Object Storage
              <select value={storageMode} onChange={e => setStorageMode(e.target.value)}>
                <option value="internal">Internal</option>
                <option value="external">External</option>
                <option value="none">None</option>
              </select>
            </label>
          </div>
          {runtimeType === 'node' ? (
            <label>
              Build Command
              <input
                value={buildCommand}
                onChange={e => setBuildCommand(e.target.value)}
                placeholder="npm run build (leave empty to skip)"
              />
            </label>
          ) : (
            <label>
              Dockerfile
              <input
                value={dockerfile}
                onChange={e => setDockerfile(e.target.value)}
                placeholder="Dockerfile"
              />
            </label>
          )}
          <p className="hint">Changing resource modes may require re-provisioning. Apps read their connection strings from injected env either way.</p>
          <button type="submit" className="primary" disabled={savingConfig}>
            {savingConfig ? 'Saving...' : 'Save Configuration'}
          </button>
        </form>
      </section>

      {/* Infrastructure */}
      <section className="settings-section">
        <h3>Infrastructure</h3>
        <div className="settings-row">
          <div>
            <strong>Subdomain:</strong> <code>{appHost(app.subdomain)}</code>
          </div>
          <div>
            <strong>Port:</strong> <code>{app.port}</code>
          </div>
          <div>
            <strong>Status:</strong>{' '}
            <span className={`badge ${app.provisioned ? 'active' : 'inactive'}`}>
              {app.provisioned ? 'Provisioned' : 'Not provisioned'}
            </span>
          </div>
        </div>
        {(app.database?.mode === 'internal' && app.internal?.dbName) && (
          <div className="settings-row">
            <div><strong>Internal DB:</strong> <code>{app.internal.dbName}</code></div>
          </div>
        )}
        {(app.storage?.mode === 'internal' && app.internal?.storagePrefix) && (
          <div className="settings-row">
            <div><strong>Storage prefix:</strong> <code>{app.internal.storagePrefix}</code></div>
          </div>
        )}
        <div className="settings-row" style={{ gap: '0.75rem' }}>
          <button onClick={handleProvision}>
            {app.provisioned ? 'Re-provision' : 'Provision App'}
          </button>
          <button onClick={handleRotateSecret}>Rotate Secret</button>
        </div>
        {newSecret && (
          <div className="secret-banner">
            <strong>New App Secret (copy now — it won't be shown again):</strong>
            <code>{newSecret}</code>
          </div>
        )}
        {provisionResult && (
          <div className="provision-banner" style={{ marginTop: '1rem' }}>
            <strong>{provisionResult.message}</strong>
            {Array.isArray(provisionResult.details) && (
              <ul>
                {provisionResult.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* GitHub Connection */}
      <section className="settings-section">
        <h3>GitHub Repository</h3>

        {app.repoConnected && app.source?.githubRepo ? (
          <div>
            <div className="settings-row">
              <div>
                <strong>Repository:</strong> <code>{app.source.githubRepo}</code>
              </div>
              <div>
                <strong>Branch:</strong> <code>{app.source.branch}</code>
              </div>
              {app.source.repoPath && (
                <div>
                  <strong>Path:</strong> <code>{app.source.repoPath}</code>
                </div>
              )}
              <div>
                <strong>Webhook:</strong>{' '}
                <span className={`badge ${app.webhookConnected ? 'active' : 'inactive'}`}>
                  {app.webhookConnected ? 'Connected' : 'Not connected'}
                </span>
              </div>
            </div>
            <p className="hint">Pushes to {app.source.branch} will automatically trigger a deploy.</p>
            <button className="danger" onClick={handleDisconnect}>Disconnect Repository</button>
          </div>
        ) : (
          <form onSubmit={handleConnect}>
            <div className="repo-connect-form">
              <div className="repo-select-row">
                <select
                  value={selectedRepo}
                  onChange={e => setSelectedRepo(e.target.value)}
                  onFocus={() => repos.length === 0 && loadRepos()}
                >
                  <option value="">Select a repository...</option>
                  {repos.map(r => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName} {r.private ? '(private)' : ''}
                    </option>
                  ))}
                </select>
                {loadingRepos && <span className="loading-text">Loading repos...</span>}
              </div>
              <label>
                Branch
                <input
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                  placeholder="main"
                />
              </label>
              <label>
                Repo Path
                <input
                  value={repoPath}
                  onChange={e => setRepoPath(e.target.value)}
                  placeholder="Leave empty for repo root, or e.g. apps/admin"
                />
              </label>
              <p className="hint">If this app lives in a subdirectory of the repo, specify the path here.</p>
              <button type="submit" disabled={!selectedRepo || connecting}>
                {connecting ? 'Connecting...' : 'Connect Repository'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* App Info */}
      <section className="settings-section">
        <h3>App Info</h3>
        <div className="settings-row">
          <div><strong>Slug:</strong> <code>{app.slug}</code></div>
          {app.description && <div><strong>Description:</strong> {app.description}</div>}
          {app.createdAt && <div><strong>Created:</strong> {new Date(app.createdAt).toLocaleDateString()}</div>}
        </div>
      </section>

      {/* Danger Zone */}
      <section className="settings-section danger-zone">
        <h3>Danger Zone</h3>
        <div className="danger-actions">
          <div className="danger-action">
            <div>
              <strong>Delete this app</strong>
              <p>Permanently remove this app, its deploy history, webhook, and routing. This cannot be undone.</p>
            </div>
            <button className="danger" onClick={handleDelete}>Delete App</button>
          </div>
        </div>
      </section>
    </div>
  );
}
