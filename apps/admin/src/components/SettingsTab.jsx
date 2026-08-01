import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost } from '../lib/appUrl';
import Select from './Select';
import useConfirm from '../lib/useConfirm';

// One settings idiom, not three.
//
// This page used to mix them: the connected-repository view used .field rows with
// a label on the left and the control on the right, the connect form used bare
// stacked labels inside the same panel, and the resources section used a third
// shape with the explanation floating below the whole row. Three layouts, three
// alignments, one page.
//
// Everything is .field rows now — the pattern the rest of Settings already uses.
// The per-option explanations moved into the dropdown itself, which is what the
// custom Select was built for: you read what "Built-in" means while deciding,
// instead of choosing blind and then reading a sentence that appears underneath.

const AUTH_OPTIONS = [
  { value: 'platform', label: 'Astrodock accounts',
    description: 'People sign in with their Astrodock account. You write no login code, and they get passkeys and two-factor for free.' },
  { value: 'public', label: 'Public — no sign-in',
    description: 'Anyone with the address can use it.' }
];
const DB_OPTIONS = [
  { value: 'internal', label: 'Built-in',
    description: 'Astrodock runs a database just for this app and hands it the connection. The easy choice.' },
  { value: 'external', label: 'Bring your own',
    description: 'A database you host elsewhere. You paste its connection string in the Variables tab.' },
  { value: 'none', label: 'None', description: 'This app does not use a database.' }
];
const STORAGE_OPTIONS = [
  { value: 'internal', label: 'Built-in',
    description: 'Astrodock gives this app its own space for uploads, images and other files.' },
  { value: 'external', label: 'Bring your own',
    description: 'Your own storage, like Amazon S3. You add the keys in the Variables tab.' },
  { value: 'none', label: 'None', description: 'This app does not store files.' }
];
const RUNTIME_OPTIONS = [
  { value: 'node', label: 'Node (zero-config)',
    description: 'Astrodock builds and runs your Node.js app. Nothing to set up.' },
  { value: 'docker', label: 'Dockerfile',
    description: 'You supply a Dockerfile and Astrodock builds and runs that — any language, full control.' }
];

export default function SettingsTab({ app, onRefresh }) {
  const navigate = useNavigate();
  const [confirmNode, ask] = useConfirm();

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
  const [noGithubToken, setNoGithubToken] = useState(false);
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

  // Load the repo list up front when there is no repo connected — that section is
  // useless without it, and making people click a dropdown to find out the server
  // has no GitHub token is a worse way to learn it.
  useEffect(() => {
    if (app.repoConnected || repos.length || loadingRepos) return;
    loadRepos();
  }, [app.repoConnected]);

  async function loadRepos() {
    setLoadingRepos(true);
    try {
      setRepos((await api.getGithubRepos()).repos);
      setNoGithubToken(false);
    } catch (err) {
      // No token configured is not an error the operator made — it is a step they
      // have not taken yet, and it gets its own explanation below rather than a
      // red banner quoting an environment variable name at them.
      if (err.status === 422) setNoGithubToken(true);
      else setError(err.message);
    } finally { setLoadingRepos(false); }
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

  function handleDisconnect() {
    ask({
      title: 'Disconnect this repository?',
      danger: true,
      confirmLabel: 'Disconnect',
      body: (
        <>
          <p>Pushes to <code>{app.source?.githubRepo}</code> will stop redeploying this app, and
            <b> Deploy now</b> and <b>Roll Back</b> will stop working until you connect a repository again.</p>
          <p className="hint">What is running right now stays running. Your code and deploy history are untouched.</p>
        </>
      ),
      onConfirm: async () => {
        setError('');
        try { await api.disconnectRepo(app.slug); setSelectedRepo(''); setSuccess('Repository disconnected'); onRefresh(); }
        catch (err) { setError(err.message); }
      }
    });
  }

  function handleRotateSecret() {
    ask({
      title: 'Make a new app secret?',
      danger: true,
      confirmLabel: 'Make a new secret',
      body: (
        <>
          <p>The current secret stops working the moment you do this. Sign-in for this app will
            fail until you redeploy it with the new one.</p>
          <p className="hint">The new secret is shown once, right after. Copy it then.</p>
        </>
      ),
      onConfirm: async () => {
        setError(''); setNewSecret(null);
        try {
          const data = await api.rotateSecret(app.slug);
          setNewSecret(data.appSecret);
          setSuccess(data.note || 'New secret created. Redeploy to apply.');
          onRefresh();
        } catch (err) { setError(err.message); }
      }
    });
  }

  function handleProvision() {
    ask({
      title: app.provisioned ? `Re-provision "${app.name}"?` : `Set up "${app.name}"?`,
      confirmLabel: app.provisioned ? 'Re-provision' : 'Set it up',
      body: app.provisioned ? (
        <>
          <p>Re-checks this app's database, storage and web address against the settings above, and
            creates anything that is missing.</p>
          <p className="hint">Existing databases and files are not touched or emptied. Redeploy
            afterwards so the app picks up any new connection details.</p>
        </>
      ) : (
        <p>Creates this app's database and file storage (for anything set to Built-in) and its web
          address. This is the one-time step between creating an app and deploying it.</p>
      ),
      onConfirm: async () => {
        setError(''); setProvisionResult(null);
        try { const data = await api.provisionApp(app.slug); setProvisionResult(data); onRefresh(); }
        catch (err) { setError(err.message); }
      }
    });
  }

  function handleDelete() {
    ask({
      title: `Delete "${app.name}"?`,
      danger: true,
      confirmLabel: 'Delete this app',
      typeToConfirm: app.slug,
      body: (
        <>
          <p>This removes the app, its deploy history, its variables and its web address. Anyone
            visiting it gets an error immediately.</p>
          <p className="hint">
            {app.database?.mode === 'internal' || app.storage?.mode === 'internal'
              ? 'Its built-in database and stored files go too. There is no undo and no backup taken for you — take one first if you might want this data.'
              : 'Anything you host elsewhere — an external database or storage — is left alone. There is no undo.'}
          </p>
        </>
      ),
      onConfirm: async () => {
        try { await api.deleteApp(app.slug); navigate('/apps'); } catch (err) { setError(err.message); }
      }
    });
  }

  const repoOptions = [
    ...repos.map((r) => ({
      value: r.fullName,
      label: r.fullName,
      description: r.private ? 'Private' : 'Public'
    }))
  ];

  return (
    <div>
      {confirmNode}
      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Source code */}
      <section className="set-section">
        <div className="sec-head">
          <div>
            <h2>Source Code</h2>
            <p>Astrodock pulls this app's code from GitHub. Connect a repository and every push to
              your chosen branch rebuilds and redeploys it automatically.</p>
          </div>
        </div>

        {app.repoConnected && app.source?.githubRepo ? (
          <div className="field-panel">
            <div className="field">
              <div className="lab"><b>Repository</b><span className="desc">Where this app's code lives.</span></div>
              <div className="ctl"><code>{app.source.githubRepo}</code></div>
            </div>
            <div className="field">
              <div className="lab"><b>Branch</b><span className="desc">Pushes to this branch trigger a deploy.</span></div>
              <div className="ctl"><code>{app.source.branch}</code></div>
            </div>
            {app.source.repoPath && (
              <div className="field">
                <div className="lab"><b>Folder</b><span className="desc">The app lives in this folder of the repository.</span></div>
                <div className="ctl"><code>{app.source.repoPath}</code></div>
              </div>
            )}
            <div className="field">
              <div className="lab">
                <b>Deploy on push</b>
                <span className="desc">
                  {app.webhookConnected
                    ? 'GitHub tells Astrodock when you push, and the app redeploys on its own.'
                    : 'Not set up — pushing to GitHub will not redeploy this app. Use Deploy now on the Deploys tab.'}
                </span>
              </div>
              <div className="ctl">
                <span className={`badge ${app.webhookConnected ? 'active' : 'inactive'}`}>
                  {app.webhookConnected ? 'On' : 'Off'}
                </span>
              </div>
            </div>
            <div className="field">
              <div className="lab"><b>Disconnect</b><span className="desc">Stop pulling code from this repository.</span></div>
              <div className="ctl"><button className="danger" onClick={handleDisconnect}>Disconnect</button></div>
            </div>
          </div>
        ) : noGithubToken ? (
          <div className="field-panel">
            <div className="field">
              <div className="lab">
                <b>No GitHub access yet</b>
                <span className="desc">
                  Astrodock needs a GitHub personal access token before it can list your
                  repositories. Add one under <Link to="/settings">Settings</Link> — it needs the
                  <code> repo</code> scope — then come back here.
                </span>
              </div>
              <div className="ctl">
                <Link to="/settings"><button type="button" className="primary">Open Settings</button></Link>
              </div>
            </div>
            <div className="field">
              <div className="lab">
                <b>Or skip GitHub entirely</b>
                <span className="desc">
                  You can push code straight from your machine with the CLI
                  (<code>astrodock deploy</code>) and never connect a repository.
                </span>
              </div>
              <div className="ctl" />
            </div>
          </div>
        ) : (
          <form onSubmit={handleConnect} className="field-panel" noValidate>
            <div className="field">
              <div className="lab">
                <b>Repository</b>
                <span className="desc">
                  {loadingRepos ? 'Loading your repositories…' : 'Pick the repository holding this app\'s code.'}
                </span>
              </div>
              <div className="ctl" style={{ width: 320 }}>
                <Select
                  value={selectedRepo}
                  onChange={setSelectedRepo}
                  options={repoOptions}
                  placeholder={loadingRepos ? 'Loading…' : 'Choose a repository…'}
                  disabled={loadingRepos}
                />
              </div>
            </div>
            <div className="field">
              <div className="lab">
                <b>Branch</b>
                <span className="desc">The branch Astrodock deploys from. Usually <code>main</code>.</span>
              </div>
              <div className="ctl">
                <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" style={{ width: 200 }} />
              </div>
            </div>
            <div className="field">
              <div className="lab">
                <b>Folder</b>
                <span className="desc">
                  Only if this app lives in a sub-folder of the repository, like <code>apps/web</code>.
                  Leave it empty for the repository root.
                </span>
              </div>
              <div className="ctl">
                <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="repository root" style={{ width: 200 }} />
              </div>
            </div>
            <div className="field">
              <div className="lab" />
              <div className="ctl">
                <button type="submit" className="primary" disabled={!selectedRepo || connecting}>
                  {connecting ? 'Connecting…' : 'Connect Repository'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      {/* Resources & runtime */}
      <section className="set-section">
        <div className="sec-head">
          <div>
            <h2>Resources &amp; How It Runs</h2>
            <p>What this app needs from Astrodock, and how it gets built. Your app reads connection
              details from Variables either way — these settings just decide where they point.</p>
          </div>
          <button className="primary" form="cfgform" disabled={savingConfig}>
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>

        <form id="cfgform" onSubmit={handleSaveConfig} className="field-panel" noValidate>
          <div className="field">
            <div className="lab"><b>Sign-in</b><span className="desc">Whether people need an account to use this app.</span></div>
            <div className="ctl" style={{ width: 280 }}>
              <Select value={authMode} onChange={setAuthMode} options={AUTH_OPTIONS} />
            </div>
          </div>
          <div className="field">
            <div className="lab"><b>Database</b><span className="desc">Where this app stores its data.</span></div>
            <div className="ctl" style={{ width: 280 }}>
              <Select value={databaseMode} onChange={setDatabaseMode} options={DB_OPTIONS} />
            </div>
          </div>
          <div className="field">
            <div className="lab"><b>File storage</b><span className="desc">Where this app keeps uploads and other files.</span></div>
            <div className="ctl" style={{ width: 280 }}>
              <Select value={storageMode} onChange={setStorageMode} options={STORAGE_OPTIONS} />
            </div>
          </div>
          <div className="field">
            <div className="lab"><b>Runtime</b><span className="desc">How Astrodock builds and runs this app.</span></div>
            <div className="ctl" style={{ width: 280 }}>
              <Select value={runtimeType} onChange={setRuntimeType} options={RUNTIME_OPTIONS} />
            </div>
          </div>
          {runtimeType === 'node' ? (
            <div className="field">
              <div className="lab">
                <b>Build command</b>
                <span className="desc">
                  Run before the app goes live — usually <code>npm run build</code>. Leave it empty
                  if there is nothing to build.
                </span>
              </div>
              <div className="ctl">
                <input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)}
                  placeholder="npm run build" style={{ width: 280 }} />
              </div>
            </div>
          ) : (
            <div className="field">
              <div className="lab">
                <b>Dockerfile</b>
                <span className="desc">Path to your Dockerfile inside the repository.</span>
              </div>
              <div className="ctl">
                <input value={dockerfile} onChange={(e) => setDockerfile(e.target.value)}
                  placeholder="Dockerfile" style={{ width: 280 }} />
              </div>
            </div>
          )}
        </form>
      </section>

      {/* Infrastructure */}
      <section className="set-section">
        <div className="sec-head">
          <div>
            <h2>Setup &amp; Web Address</h2>
            <p>Provisioning creates this app's moving parts — its database and storage, if they are
              set to Built-in, and its web address. Run it once after creating the app, and again
              whenever you change the resources above.</p>
          </div>
          <button onClick={handleProvision}>{app.provisioned ? 'Re-provision' : 'Set It Up'}</button>
        </div>
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
        <div className="sec-head">
          <div>
            <h2>App Secret</h2>
            <p>A private password this app uses to talk to Astrodock's sign-in service. If it ever
              leaks, make a new one here — then redeploy so the app picks it up.</p>
          </div>
          <button onClick={handleRotateSecret}>Make a New Secret</button>
        </div>
        {newSecret && (
          <div className="secret-banner">
            <strong>New app secret — copy it now, it won't be shown again</strong>
            <code>{newSecret}</code>
          </div>
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
            <div>
              <strong>Delete this app</strong>
              <p>Permanently removes the app, its deploy history, its variables and its web address.
                This can't be undone.</p>
            </div>
            <button className="danger" onClick={handleDelete}>Delete App</button>
          </div>
        </div>
      </section>
    </div>
  );
}
