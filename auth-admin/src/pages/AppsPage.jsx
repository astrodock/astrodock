import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';

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

export default function AppsPage() {
  const [apps, setApps] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [newApp, setNewApp] = useState({ slug: '', name: '', description: '', subdomain: '', usePlatformAuth: true, usePlatformDb: true });
  const [revealedSecret, setRevealedSecret] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const [appData, statusData] = await Promise.all([
        api.getApps(),
        api.getAllAppStatuses().catch(() => ({ statuses: {} }))
      ]);
      setApps(appData.apps);
      setStatuses(statusData.statuses);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    try {
      const data = await api.createApp(newApp);
      setRevealedSecret({ slug: data.app.slug, secret: data.appSecret });
      setShowCreate(false);
      setNewApp({ slug: '', name: '', description: '', subdomain: '', usePlatformAuth: true, usePlatformDb: true });
      load();
    } catch (err) {
      setError(err.message);
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

  function getAppStatus(app) {
    const pmName = `${app.slug}-api`;
    const status = statuses[pmName];
    if (!app.isProvisioned) return { label: 'Not provisioned', className: 'inactive' };
    if (!status) return { label: 'Not running', className: 'inactive' };
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
          <button onClick={() => setRevealedSecret(null)}>Dismiss</button>
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
              <tr key={app._id} onClick={() => navigate(`/apps/${app.slug}`)}>
                <td>
                  <strong>{app.name}</strong>
                  <span className="row-subtitle">{app.slug}</span>
                </td>
                <td>
                  <a
                    href={`https://${app.subdomain}.seniorverse.dev`}
                    className="app-link"
                    target="_blank"
                    rel="noopener"
                    onClick={e => e.stopPropagation()}
                  >
                    {app.subdomain}.seniorverse.dev
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
                  {app.githubRepo
                    ? <code>{app.githubRepo}</code>
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
              <div className="input-suffix">
                <input
                  value={newApp.subdomain}
                  onChange={e => setNewApp({ ...newApp, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="model"
                  pattern="[a-z0-9\-]+"
                  required
                />
                <span>.seniorverse.dev</span>
              </div>
            </label>
            <label>
              Description
              <input
                value={newApp.description}
                onChange={e => setNewApp({ ...newApp, description: e.target.value })}
                placeholder="Optional description"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={newApp.usePlatformAuth}
                onChange={e => setNewApp({ ...newApp, usePlatformAuth: e.target.checked })}
              />
              Uses platform authentication
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={newApp.usePlatformDb}
                onChange={e => setNewApp({ ...newApp, usePlatformDb: e.target.checked })}
              />
              Uses platform database
            </label>
            <p className="hint">Port will be auto-assigned.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit">Create</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
