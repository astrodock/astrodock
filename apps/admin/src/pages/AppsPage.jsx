import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost, appUrl } from '../lib/appUrl';

const STATUS_CLASSES = {
  online: 'active',
  stopped: 'inactive',
  errored: 'errored'
};

const STATUS_LABELS = {
  online: 'Running',
  stopped: 'Stopped',
  errored: 'Errored'
};

const BLANK_APP = {
  slug: '',
  name: '',
  description: '',
  subdomain: '',
  runtimeType: 'node',
  authMode: 'platform',
  databaseMode: 'internal',
  storageMode: 'none',
  branch: 'main',
  repoPath: ''
};

export default function AppsPage() {
  const [apps, setApps] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [newApp, setNewApp] = useState(BLANK_APP);
  const [creating, setCreating] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const [appData, statusData] = await Promise.all([
        api.getApps(),
        api.getAllAppStatuses().catch(() => ({ statuses: {} }))
      ]);
      setApps(appData.apps);
      setStatuses(statusData.statuses || {});
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const data = await api.createApp(newApp);
      setRevealedSecret({ slug: data.app.slug, secret: data.appSecret });
      setCopied(false);
      setShowCreate(false);
      setNewApp(BLANK_APP);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function handleSlugChange(value) {
    const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const subdomainMatchesSlug = newApp.subdomain === '' || newApp.subdomain === newApp.slug;
    setNewApp({
      ...newApp,
      slug,
      subdomain: subdomainMatchesSlug ? slug : newApp.subdomain
    });
  }

  function copySecret() {
    if (!revealedSecret) return;
    navigator.clipboard?.writeText(revealedSecret.secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function getAppStatus(app) {
    const status = statuses[app.slug];
    if (!app.provisioned) return { label: 'Not provisioned', className: 'inactive' };
    if (!status || status === 'unavailable') return { label: 'Not running', className: 'inactive' };
    return {
      label: STATUS_LABELS[status] || status,
      className: STATUS_CLASSES[status] || 'inactive'
    };
  }

  return (
    <div>
      <div className="page-header">
        <h1>Apps</h1>
        <button onClick={() => setShowCreate(true)}>Register App</button>
      </div>

      {error && <div className="error">{error}</div>}

      {revealedSecret && (
        <div className="secret-banner">
          <strong>App Secret for "{revealedSecret.slug}"</strong>
          <code>{revealedSecret.secret}</code>
          <p>Copy this now — it will not be shown again.</p>
          <div className="modal-actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
            <button onClick={copySecret}>{copied ? 'Copied!' : 'Copy'}</button>
            <button onClick={() => setRevealedSecret(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <table className="data-table clickable">
        <thead>
          <tr>
            <th>Name</th>
            <th>Subdomain</th>
            <th>Port</th>
            <th>Process</th>
            <th>Repository</th>
          </tr>
        </thead>
        <tbody>
          {apps.map(app => {
            const status = getAppStatus(app);
            return (
              <tr key={app.id} onClick={() => navigate(`/apps/${app.slug}`)}>
                <td>
                  <strong>{app.name}</strong>
                  <span className="row-subtitle">{app.slug}</span>
                </td>
                <td>
                  <a
                    href={appUrl(app.subdomain)}
                    className="app-link"
                    target="_blank"
                    rel="noopener"
                    onClick={e => e.stopPropagation()}
                  >
                    {appHost(app.subdomain)}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3M9 2h5v5M15 1L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </a>
                </td>
                <td><code>{app.port}</code></td>
                <td>
                  <span className="process-status-inline">
                    <span className={`process-dot-sm ${status.className}`} />
                    {status.label}
                  </span>
                </td>
                <td>
                  {app.source?.githubRepo
                    ? <code>{app.source.githubRepo}</code>
                    : <span className="text-muted">Not connected</span>
                  }
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleCreate}>
            <h2>Register App</h2>
            <label>
              Slug
              <input
                value={newApp.slug}
                onChange={e => handleSlugChange(e.target.value)}
                placeholder="financial-model"
                pattern="[a-z0-9\-]+"
                required
                autoFocus
              />
            </label>
            <label>
              Name
              <input
                value={newApp.name}
                onChange={e => setNewApp({ ...newApp, name: e.target.value })}
                placeholder="Financial Model"
                required
              />
            </label>
            <label>
              Subdomain
              <input
                value={newApp.subdomain}
                onChange={e => setNewApp({ ...newApp, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                placeholder="model"
                pattern="[a-z0-9\-]+"
                required
              />
            </label>
            <label>
              Description
              <input
                value={newApp.description}
                onChange={e => setNewApp({ ...newApp, description: e.target.value })}
                placeholder="Optional description"
              />
            </label>

            <div className="form-row">
              <label>
                Runtime
                <select
                  value={newApp.runtimeType}
                  onChange={e => setNewApp({ ...newApp, runtimeType: e.target.value })}
                >
                  <option value="node">Node buildpack</option>
                  <option value="docker">Dockerfile</option>
                </select>
              </label>
              <label>
                Authentication
                <select
                  value={newApp.authMode}
                  onChange={e => setNewApp({ ...newApp, authMode: e.target.value })}
                >
                  <option value="platform">Platform-managed</option>
                  <option value="public">Public (no auth)</option>
                </select>
              </label>
            </div>

            <div className="form-row">
              <label>
                Database
                <select
                  value={newApp.databaseMode}
                  onChange={e => setNewApp({ ...newApp, databaseMode: e.target.value })}
                >
                  <option value="internal">Internal</option>
                  <option value="external">External</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label>
                Object Storage
                <select
                  value={newApp.storageMode}
                  onChange={e => setNewApp({ ...newApp, storageMode: e.target.value })}
                >
                  <option value="internal">Internal</option>
                  <option value="external">External</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>

            <p className="hint">Port will be auto-assigned. Connect a repo and set required env vars before deploying.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
