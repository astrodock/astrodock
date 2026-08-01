import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import { appHost, appUrl } from '../lib/appUrl';
import PageHeader from '../components/PageHeader';
import { SkeletonRows } from '../components/Loading';
import Select from '../components/Select';

// Same wording as the app's Settings tab — the choice you make here is the same
// choice, and it should not be described two different ways.
const RUNTIME_OPTS = [
  { value: 'node', label: 'Node (zero-config)', description: 'Astrodock builds and runs your Node.js app. Nothing to set up.' },
  { value: 'docker', label: 'Dockerfile', description: 'You supply a Dockerfile — any language, full control.' }
];
const AUTH_OPTS = [
  { value: 'platform', label: 'Astrodock accounts', description: 'People sign in with their Astrodock account. You write no login code.' },
  { value: 'public', label: 'Public — no sign-in', description: 'Anyone with the address can use it.' }
];
const DB_OPTS = [
  { value: 'internal', label: 'Built-in', description: 'Astrodock runs a database just for this app. The easy choice.' },
  { value: 'external', label: 'Bring your own', description: 'A database you host elsewhere.' },
  { value: 'none', label: 'None', description: 'This app does not use a database.' }
];
const STORAGE_OPTS = [
  { value: 'internal', label: 'Built-in', description: 'Astrodock gives this app its own space for uploads and files.' },
  { value: 'external', label: 'Bring your own', description: 'Your own storage, like Amazon S3.' },
  { value: 'none', label: 'None', description: 'This app does not store files.' }
];

const STMAP = {
  running: { badge: 'Running', cls: 'running', led: 'ok' },
  down: { badge: 'Down', cls: 'down', led: 'crit' },
  stopped: { badge: 'Stopped', cls: 'stopped', led: 'inactive' },
  unprovisioned: { badge: 'Not provisioned', cls: 'stopped', led: 'inactive' }
};
const RANK = { down: 0, running: 1, stopped: 2, unprovisioned: 3 };
function fmtBytes(b) { if (!b) return '—'; return b < 1073741824 ? `${(b / 1048576).toFixed(0)} MB` : `${(b / 1073741824).toFixed(1)} GB`; }

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
  const [loaded, setLoaded] = useState(false);
  const [reserved, setReserved] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [health, setHealth] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [newApp, setNewApp] = useState(BLANK_APP);
  const [creating, setCreating] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const [appData, statusData, healthData] = await Promise.all([
        api.getApps(),
        api.getAllAppStatuses().catch(() => ({ statuses: {} })),
        api.getHealth().catch(() => ({ apps: [] }))
      ]);
      setApps(appData.apps);
      setStatuses(statusData.statuses || {});
      const hmap = {};
      (healthData.apps || []).forEach((a) => { hmap[a.slug] = a; });
      setHealth(hmap);
    } catch (err) {
      setError(err.message);
    }
    setLoaded(true);
  }

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { api.getReservedSubdomains().then((d) => setReserved(d.reserved || [])).catch(() => {}); }, []);

  // Checked as you type rather than on submit, so a reserved name never gets as
  // far as a round trip that comes back saying no.
  const wanted = (newApp.subdomain || newApp.slug || '').toLowerCase();
  const takenReason = reserved.find((r) => r.name === wanted)?.reason || null;

  function statusOf(app) {
    if (!app.provisioned) return 'unprovisioned';
    const s = statuses[app.slug];
    if (s === 'online') return 'running';
    if (s === 'errored') return 'down';
    return 'stopped';
  }

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

  const sorted = [...apps].sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)]);
  const counts = apps.reduce((m, a) => { const s = statusOf(a); m[s] = (m[s] || 0) + 1; return m; }, {});

  return (
    <div>
      <PageHeader
        title="Apps"
        description="Apps are Git repos Astrodock builds, runs and serves, each at its own web address."
        action={<button onClick={() => setShowCreate(true)}>Register App</button>}
      />

      {apps.length > 0 && (
        <div className="apps-summary">
          <b>{apps.length}</b> apps
          <span className="sep">·</span><b style={{ color: counts.down ? 'var(--danger)' : 'var(--text-2)' }}>{counts.down || 0}</b> down
          <span className="sep">·</span><b>{counts.running || 0}</b> running
          <span className="sep">·</span><b>{(counts.stopped || 0) + (counts.unprovisioned || 0)}</b> stopped
        </div>
      )}

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

      {!loaded ? <SkeletonRows rows={3} cols={4} /> : apps.length === 0 ? (
        <EmptyState icon="apps" title="No apps yet"
          body="Register one to build, run and serve it."
          action={<button onClick={() => setShowCreate(true)}>Register App</button>} />
      ) : (
        <div className="app-grid">
          {sorted.map((app) => {
            const st = statusOf(app);
            const m = STMAP[st];
            const h = health[app.slug] || {};
            return (
              <div className={`appcard ${m.cls}`} key={app.id} onClick={() => navigate(`/apps/${app.slug}`)}>
                <div className="ac-top">
                  <span className={`led ${m.led}`} />
                  <span className="ac-name">{app.name}</span>
                  <span className={`statusbadge ${m.cls}`}>{m.badge}</span>
                </div>
                <div className="ac-hostrow">
                  <span className="ac-rt">{app.runtime?.type === 'docker' ? 'Docker' : 'Node'}</span>
                  <a href={appUrl(app.subdomain)} className="ac-host" target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                    {appHost(app.subdomain)}
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3M9 2h5v5M15 1L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </a>
                </div>
                <div className="ac-stats">
                  <div><label>Response</label><b>{h.responseTime != null ? `${h.responseTime} ms` : '—'}</b></div>
                  <div><label>Memory</label><b>{h.proc ? fmtBytes(h.proc.memory) : '—'}</b></div>
                  <div><label>Repo</label><b style={{ fontWeight: 500, fontSize: 13 }}>{app.source?.githubRepo ? app.source.githubRepo.split('/').pop() : 'none'}</b></div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} noValidate onSubmit={handleCreate}>
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
            <label className={takenReason ? 'has-error' : ''}>
              Subdomain
              <input
                value={newApp.subdomain}
                onChange={e => setNewApp({ ...newApp, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                placeholder="model"
              />
              {takenReason
                ? <span className="field-error">That name is reserved for {takenReason}.</span>
                : <span className="hint">
                    Its address will be <code>{appHost(newApp.subdomain || newApp.slug || 'name')}</code>.
                    {reserved.length > 0 && <> Reserved: {reserved.map((r) => r.name).join(', ')}.</>}
                  </span>}
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
                <Select value={newApp.runtimeType} onChange={v => setNewApp({ ...newApp, runtimeType: v })}
                  options={RUNTIME_OPTS} />
              </label>
              <label>
                Authentication
                <Select value={newApp.authMode} onChange={v => setNewApp({ ...newApp, authMode: v })}
                  options={AUTH_OPTS} />
              </label>
            </div>

            <div className="form-row">
              <label>
                Database
                <Select value={newApp.databaseMode} onChange={v => setNewApp({ ...newApp, databaseMode: v })}
                  options={DB_OPTS} />
              </label>
              <label>
                Object Storage
                <Select value={newApp.storageMode} onChange={v => setNewApp({ ...newApp, storageMode: v })}
                  options={STORAGE_OPTS} />
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
