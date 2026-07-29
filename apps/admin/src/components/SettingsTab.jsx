import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost } from '../lib/appUrl';

const AUTH_HELP = {
  platform: 'Astrodock handles sign-in for this app — your users log in with their Astrodock account, and you don’t write any login code.',
  public: 'No sign-in. Anyone who has the address can use this app.'
};
const DB_HELP = {
  internal: 'Astrodock creates and runs a database just for this app and hands it the connection automatically. The easy choice.',
  external: 'Use a database you host somewhere else — you’ll paste its connection string in the Variables tab.',
  none: 'This app doesn’t use a database.'
};
const STORAGE_HELP = {
  internal: 'Astrodock gives this app its own space to store files (uploads, images, and so on).',
  external: 'Use your own file storage, like Amazon S3 — you’ll add the keys in the Variables tab.',
  none: 'This app doesn’t store files.'
};
const RUNTIME_HELP = {
  node: 'Astrodock builds and runs your Node.js app for you, with no setup. Best when your app is plain Node.',
  docker: 'You include a Dockerfile and Astrodock builds and runs that. Use this for any language, or for full control.'
};

export default function SettingsTab({ app, onRefresh }) {
  const navigate = useNavigate();
  const [authMode, setAuthMode] = useState(app.auth?.mode || 'platform');
  const [databaseMode, setDatabaseMode] = useState(app.database?.mode || 'none');
  const [storageMode, setStorageMode] = useState(app.storage?.mode || 'none');
  const [runtimeType, setRuntimeType] = useState(app.runtime?.type || 'node');
  const [buildCommand, setBuildCommand] = useState(app.runtime?.buildCommand || '');
  const [dockerfile, setDockerfile] = useState(app.runtime?.dockerfile || '');
  const [savingConfig, setSavingConfig] = useState(false);

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

  useEffect(() => {
    setAuthMode(app.auth?.mode || 'platform'); setDatabaseMode(app.database?.mode || 'none');
    setStorageMode(app.storage?.mode || 'none'); setRuntimeType(app.runtime?.type || 'node');
    setBuildCommand(app.runtime?.buildCommand || ''); setDockerfile(app.runtime?.dockerfile || '');
    setSelectedRepo(app.source?.githubRepo || ''); setBranch(app.source?.branch || 'main'); setRepoPath(app.source?.repoPath || '');
  }, [app]);

  async function loadRepos() {
    setLoadingRepos(true);
    try { setRepos((await api.getGithubRepos()).repos); } catch (err) { setError(err.message); } finally { setLoadingRepos(false); }
  }
  async function handleSaveConfig(e) {
    e.preventDefault(); setSavingConfig(true); setError(''); setSuccess('');
    try {
      await api.updateApp(app.slug, { authMode, databaseMode, storageMode, runtimeType, buildCommand, dockerfile });
      setSuccess('Saved. If you changed Database or Storage, re-provision below, then redeploy.');
      onRefresh();
    } catch (err) { setError(err.message); } finally { setSavingConfig(false); }
  }
  async function handleConnect(e) {
    e.preventDefault(); if (!selectedRepo) return; setConnecting(true); setError(''); setSuccess('');
    try { await api.connectRepo(app.slug, selectedRepo, branch, repoPath); setSuccess(`Connected to ${selectedRepo} (${branch})`); onRefresh(); }
    catch (err) { setError(err.message); } finally { setConnecting(false); }
  }
  async function handleDisconnect() {
    if (!confirm('Disconnect this repository? Pushes will no longer redeploy automatically.')) return;
    setError('');
    try { await api.disconnectRepo(app.slug); setSelectedRepo(''); setSuccess('Repository disconnected'); onRefresh(); } catch (err) { setError(err.message); }
  }
  async function handleRotateSecret() {
    if (!confirm('Make a new secret? The current one stops working right away, and you’ll need to redeploy this app.')) return;
    setError(''); setNewSecret(null);
    try { const data = await api.rotateSecret(app.slug); setNewSecret(data.appSecret); setSuccess(data.note || 'New secret created. Redeploy to apply.'); onRefresh(); } catch (err) { setError(err.message); }
  }
  async function handleProvision() {
    if (!confirm(`Set up "${app.name}"? This creates its database/storage (if internal) and its web address.`)) return;
    setError(''); setProvisionResult(null);
    try { const data = await api.provisionApp(app.slug); setProvisionResult(data); onRefresh(); } catch (err) { setError(err.message); }
  }
  async function handleDelete() {
    if (!confirm(`Delete "${app.name}"? This removes the app, its deploy history, and its web address. This cannot be undone.`)) return;
    try { await api.deleteApp(app.slug); navigate('/apps'); } catch (err) { setError(err.message); }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Source code */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Source Code</h2><p>Astrodock pulls this app’s code from GitHub. Connect a repo, and every push to your chosen branch can rebuild and redeploy it automatically.</p></div></div>
        {app.repoConnected && app.source?.githubRepo ? (
          <div className="field-panel">
            <div className="field"><div className="lab"><b>Repository</b><span className="desc">Where your code lives.</span></div><div className="ctl"><code>{app.source.githubRepo}</code></div></div>
            <div className="field"><div className="lab"><b>Branch</b><span className="desc">Pushes here trigger a deploy.</span></div><div className="ctl"><code>{app.source.branch}</code></div></div>
            {app.source.repoPath && <div className="field"><div className="lab"><b>Folder</b><span className="desc">The app lives in this folder of the repo.</span></div><div className="ctl"><code>{app.source.repoPath}</code></div></div>}
            <div className="field"><div className="lab"><b>Auto-deploy</b><span className="desc">A GitHub webhook that redeploys when you push. {app.webhookConnected ? 'It’s on.' : 'It isn’t set up — you’ll deploy manually.'}</span></div><div className="ctl"><span className={`badge ${app.webhookConnected ? 'active' : 'inactive'}`}>{app.webhookConnected ? 'On' : 'Off'}</span></div></div>
            <div className="field"><div className="lab" /><div className="ctl"><button className="danger" onClick={handleDisconnect}>Disconnect Repository</button></div></div>
          </div>
        ) : (
          <form onSubmit={handleConnect} className="field-panel" noValidate>
            <label>Repository
              <select value={selectedRepo} onChange={(e) => setSelectedRepo(e.target.value)} onFocus={() => repos.length === 0 && loadRepos()}>
                <option value="">Choose a repository…</option>
                {repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName} {r.private ? '(private)' : ''}</option>)}
              </select>
            </label>
            {loadingRepos && <p className="field-help">Loading your repositories…</p>}
            <label>Branch<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
            <p className="field-help">The branch Astrodock deploys from. Usually <code>main</code>.</p>
            <label>Folder <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>— optional</span><input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="leave empty for the repo root" /></label>
            <p className="field-help">Only needed if this app lives in a sub-folder of the repo (e.g. <code>apps/web</code>).</p>
            <button type="submit" className="primary" disabled={!selectedRepo || connecting} style={{ marginTop: 6 }}>{connecting ? 'Connecting…' : 'Connect repository'}</button>
          </form>
        )}
      </section>

      {/* Resources & runtime */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Resources &amp; How It Runs</h2><p>What this app needs from Astrodock, and how it’s built. Your app reads any connection details from Variables, so changing these just decides where they point.</p></div><button className="primary" form="cfgform" disabled={savingConfig}>{savingConfig ? 'Saving…' : 'Save'}</button></div>
        <form id="cfgform" onSubmit={handleSaveConfig} className="field-panel" noValidate>
          <div className="cfg">
            <label>Sign-in<select value={authMode} onChange={(e) => setAuthMode(e.target.value)}><option value="platform">Astrodock accounts</option><option value="public">Public — no sign-in</option></select></label>
            <p className="field-help">{AUTH_HELP[authMode]}</p>
          </div>
          <div className="cfg">
            <label>Database<select value={databaseMode} onChange={(e) => setDatabaseMode(e.target.value)}><option value="internal">Built-in (managed for you)</option><option value="external">Bring your own</option><option value="none">None</option></select></label>
            <p className="field-help">{DB_HELP[databaseMode]}</p>
          </div>
          <div className="cfg">
            <label>File storage<select value={storageMode} onChange={(e) => setStorageMode(e.target.value)}><option value="internal">Built-in (managed for you)</option><option value="external">Bring your own</option><option value="none">None</option></select></label>
            <p className="field-help">{STORAGE_HELP[storageMode]}</p>
          </div>
          <div className="cfg">
            <label>Runtime<select value={runtimeType} onChange={(e) => setRuntimeType(e.target.value)}><option value="node">Node (zero-config)</option><option value="docker">Dockerfile</option></select></label>
            <p className="field-help">{RUNTIME_HELP[runtimeType]}</p>
          </div>
          {runtimeType === 'node' ? (
            <div className="cfg"><label>Build command<input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" /></label><p className="field-help">The command that prepares your app before it goes live (usually <code>npm run build</code>). Leave empty if there’s nothing to build.</p></div>
          ) : (
            <div className="cfg"><label>Dockerfile<input value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} placeholder="Dockerfile" /></label><p className="field-help">The path to your Dockerfile in the repo. Defaults to <code>Dockerfile</code>.</p></div>
          )}
        </form>
      </section>

      {/* Infrastructure */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Setup &amp; Web Address</h2><p>Provisioning sets up this app’s moving parts — its database and storage (if built-in) and its web address. Run it once after creating the app, and again whenever you change the resources above.</p></div><button onClick={handleProvision}>{app.provisioned ? 'Re-provision' : 'Set it up'}</button></div>
        <div className="diag">
          <div className="drow"><label>Web address</label><div className="v">{appHost(app.subdomain)}</div></div>
          <div className="drow"><label>Internal port</label><div className="v">{app.port}</div></div>
          <div className="drow"><label>Status</label><div className="v"><span className={`badge ${app.provisioned ? 'active' : 'inactive'}`}>{app.provisioned ? 'Set up' : 'Not set up'}</span></div></div>
          {app.database?.mode === 'internal' && app.internal?.dbName && <div className="drow"><label>Database name</label><div className="v">{app.internal.dbName}</div></div>}
          {app.storage?.mode === 'internal' && app.internal?.storagePrefix && <div className="drow"><label>Storage prefix</label><div className="v">{app.internal.storagePrefix}</div></div>}
        </div>
        {provisionResult && (
          <div className="provision-banner" style={{ marginTop: 14 }}>
            <strong>{provisionResult.message}</strong>
            {Array.isArray(provisionResult.details) && <ul>{provisionResult.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </div>
        )}
      </section>

      {/* App secret */}
      <section className="set-section">
        <div className="sec-head"><div><h2>App Secret</h2><p>A private password this app uses to talk to Astrodock’s sign-in service. Keep it safe. If it ever leaks, make a new one here — then redeploy so the app picks it up.</p></div><button onClick={handleRotateSecret}>Make a New Secret</button></div>
        {newSecret && (
          <div className="secret-banner"><strong>New app secret — copy it now, it won’t be shown again</strong><code>{newSecret}</code></div>
        )}
      </section>

      {/* About */}
      <section className="set-section">
        <div className="sec-head"><div><h2>About This App</h2></div></div>
        <div className="diag">
          <div className="drow"><label>ID (slug)</label><div className="v">{app.slug}</div></div>
          {app.description && <div className="drow"><label>Description</label><div className="v" style={{ fontFamily: 'var(--font)' }}>{app.description}</div></div>}
          {app.createdAt && <div className="drow"><label>Created</label><div className="v">{new Date(app.createdAt).toLocaleDateString()}</div></div>}
        </div>
      </section>

      {/* Danger zone */}
      <section className="set-section danger-zone">
        <h3>Danger Zone</h3>
        <div className="danger-actions">
          <div className="danger-action">
            <div><strong>Delete this app</strong><p>Permanently removes the app, its deploy history, and its web address. This can’t be undone.</p></div>
            <button className="danger" onClick={handleDelete}>Delete App</button>
          </div>
        </div>
      </section>
    </div>
  );
}
