import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';

export default function SettingsTab({ app, onRefresh }) {
  const navigate = useNavigate();
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(app.githubRepo || '');
  const [branch, setBranch] = useState(app.branch || 'main');
  const [repoPath, setRepoPath] = useState(app.repoPath || '');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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

  const [newSecret, setNewSecret] = useState(null);

  async function handleRotateSecret() {
    if (!confirm('Rotate the app secret? The current secret will stop working immediately. You will need to redeploy the app.')) return;
    setError('');
    setNewSecret(null);
    try {
      const data = await api.rotateSecret(app.slug);
      setNewSecret(data.appSecret);
      setSuccess('App secret rotated. Redeploy to apply.');
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleProvision() {
    if (!confirm(`Provision "${app.name}"? This will create directories and update Caddy routing.`)) return;
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

  return (
    <div>
      <div className="tab-header">
        <h2>Settings</h2>
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Platform Features */}
      <section className="settings-section">
        <h3>Platform Features</h3>
        <div className="settings-row">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={app.usePlatformAuth ?? true}
              onChange={async (e) => {
                const checked = e.target.checked;
                setError('');
                try {
                  await api.updateApp(app.slug, { usePlatformAuth: checked });
                  onRefresh();
                  setSuccess(`Platform auth ${checked ? 'enabled' : 'disabled'}`);
                } catch (err) {
                  setError(err.message);
                }
              }}
            />
            Uses platform authentication
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={app.usePlatformDb ?? true}
              onChange={async (e) => {
                const checked = e.target.checked;
                setError('');
                try {
                  await api.updateApp(app.slug, { usePlatformDb: checked });
                  onRefresh();
                  setSuccess(`Platform database ${checked ? 'enabled' : 'disabled'}`);
                } catch (err) {
                  setError(err.message);
                }
              }}
            />
            Uses platform database
          </label>
        </div>
        <p className="hint">Controls which system env vars are included. Changing these does not add/remove env vars from existing deployments.</p>
      </section>

      {/* Provisioning */}
      <section className="settings-section">
        <h3>Infrastructure</h3>
        <div className="settings-row">
          <div>
            <strong>Subdomain:</strong> <code>{app.subdomain}.seniorverse.dev</code>
          </div>
          <div>
            <strong>Port:</strong> <code>{app.port}</code>
          </div>
          <div>
            <strong>Status:</strong>{' '}
            <span className={`badge ${app.isProvisioned ? 'active' : 'inactive'}`}>
              {app.isProvisioned ? 'Provisioned' : 'Not provisioned'}
            </span>
          </div>
        </div>
        <div className="settings-row" style={{ gap: '0.75rem' }}>
          <button onClick={handleProvision}>
            {app.isProvisioned ? 'Re-provision' : 'Provision App'}
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
            <ul>
              {provisionResult.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
        )}
      </section>

      {/* GitHub Connection */}
      <section className="settings-section">
        <h3>GitHub Repository</h3>

        {app.githubRepo ? (
          <div>
            <div className="settings-row">
              <div>
                <strong>Repository:</strong> <code>{app.githubRepo}</code>
              </div>
              <div>
                <strong>Branch:</strong> <code>{app.branch}</code>
              </div>
              {app.repoPath && (
                <div>
                  <strong>Path:</strong> <code>{app.repoPath}</code>
                </div>
              )}
            </div>
            <p className="hint">Pushes to {app.branch} will automatically trigger a deploy.</p>
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
                  placeholder="Leave empty for repo root, or e.g. packages/admin"
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
          <div><strong>Created:</strong> {new Date(app.createdAt).toLocaleDateString()}</div>
        </div>
      </section>

      {/* Danger Zone */}
      <section className="settings-section danger-zone">
        <h3>Danger Zone</h3>
        <div className="danger-actions">
          <div className="danger-action">
            <div>
              <strong>Delete this app</strong>
              <p>Permanently remove this app, its deploy history, webhook, and Caddy routing. This cannot be undone.</p>
            </div>
            <button className="danger" onClick={async () => {
              if (!confirm(`Delete "${app.name}"? This will remove the app, all deployments, and Caddy routing. This cannot be undone.`)) return;
              try {
                await api.deleteApp(app.slug);
                navigate('/apps');
              } catch (err) {
                setError(err.message);
              }
            }}>Delete App</button>
          </div>
        </div>
      </section>
    </div>
  );
}
