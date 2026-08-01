import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import EnvVarRow from './EnvVarRow';
import ReauthModal from './ReauthModal';
import useConfirm from '../lib/useConfirm';

export default function EnvVarsTab({ app, onRefresh }) {
  const [envVars, setEnvVars] = useState([]);
  const [missingRequired, setMissingRequired] = useState([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkResult, setBulkResult] = useState(null);
  const [error, setError] = useState('');
  const [newSecret, setNewSecret] = useState(false);
  const [reauth, setReauth] = useState(null);
  const [confirmNode, ask] = useConfirm();
  const [runtimeEnv, setRuntimeEnv] = useState(null);

  async function load() {
    try {
      const data = await api.getEnvVars(app.slug);
      setEnvVars(data.envVars || []);
      setMissingRequired(data.missingRequired || []);
      onRefresh?.();
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [app.slug]);
  useEffect(() => {
    // What the app is actually handed. The runner already computes and masks this
    // for the Operations tab; it belongs here too.
    api.opsEnv(app.slug)
      .then((d) => setRuntimeEnv(Object.entries(d.env || {}).filter(([k]) => k.startsWith('ASTRODOCK_'))))
      .catch(() => setRuntimeEnv([]));
  }, [app.slug]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newKey || !newValue) return;
    setError('');
    try {
      await api.setEnvVar(app.slug, newKey, newValue, newSecret);
      setNewKey(''); setNewValue(''); setNewSecret(false); load();
    }
    catch (err) { setError(err.message); }
  }
  async function handleBulkImport(e) {
    e.preventDefault();
    setError(''); setBulkResult(null);
    try { const data = await api.bulkImportEnv(app.slug, bulkText); setBulkResult(data); setBulkText(''); load(); }
    catch (err) { setError(err.message); }
  }

  const yours = envVars.filter((v) => v.kind === 'declared');
  const provided = envVars.filter((v) => v.kind === 'reserved');

  async function reveal(key, setShown) {
    try {
      const r = await api.revealEnvVar(app.slug, key);
      setShown(r.value);
    } catch (err) {
      if (err.body?.code === 'reauth_required') { setReauth({ retry: () => reveal(key, setShown) }); return; }
      setError(err.message);
    }
  }

  return (
    <div>
      {confirmNode}
      {reauth && (
        <ReauthModal
          action="Revealing a stored secret"
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}

      <div className="sec-head">
        <div>
          <h2>Variables</h2>
          <p>
            Settings your app reads while it runs — API keys, connection strings, feature flags.
            Changes take effect on the next deploy.
          </p>
        </div>
        <button onClick={() => setShowBulk(true)}>Import .env</button>
      </div>

      {error && <div className="error">{error}</div>}

      {missingRequired.length > 0 && (
        <div className="rcard warn" style={{ marginBottom: 14 }}>
          <span className="led warn" />
          <span>
            <b>{missingRequired.length} required variable{missingRequired.length > 1 ? 's' : ''} still needs a value.</b>{' '}
            Deploys are blocked until then: {missingRequired.map((m) => m.key).join(', ')}
          </span>
        </div>
      )}

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>Yours</h2>
          <p>Ones you add here, or that the app declares in its <code>app.json</code>.</p>
        </div>
      </div>

      {yours.length === 0 ? (
        <EmptyState icon="env" title="No variables yet"
          body="Add one below, or import a .env file." />
      ) : (
        <div className="var-list">
          {yours.map((v) => (
            <EnvVarRow key={v.key} v={v} appSlug={app.slug} deletable
              onChanged={load} onError={setError} onReveal={reveal}
              onDelete={(key) => ask({
                title: `Delete ${key}?`,
                body: <>The app stops receiving it on the next deploy. If the app needs it, that
                  deploy will fail until you set it again.</>,
                danger: true, confirmLabel: 'Delete',
                onConfirm: async () => { await api.deleteEnvVar(app.slug, key); await load(); }
              })} />
          ))}
        </div>
      )}

      <div className="var-add">
        <form onSubmit={handleAdd} noValidate>
          <div className="var-add-row">
            <input className="k" value={newKey} placeholder="NAME"
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
            <input type={newSecret ? 'password' : 'text'} value={newValue} placeholder="Value"
              onChange={(e) => setNewValue(e.target.value)} />
            <button type="submit" className="primary" disabled={!newKey || !newValue}>Add</button>
          </div>
          <div className="var-add-opts">
            <label className="var-add-opt">
              <span className={`mini-toggle sm ${newSecret ? 'on' : ''}`} role="switch"
                aria-checked={newSecret} onClick={() => setNewSecret(!newSecret)} />
              Treat as a secret
            </label>
            <span className="hint" style={{ margin: 0 }}>
              {newSecret
                ? 'Stored encrypted and hidden here. You can reveal it later, which asks you to confirm and is recorded.'
                : 'Stored as written and readable on this page. Use a secret for anything you would not paste in chat.'}
            </span>
          </div>
        </form>
      </div>

      {provided.length > 0 && (
        <>
          <div className="sec-head" style={{ marginTop: 30 }}>
            <div>
              <h2>Provided by Astrodock</h2>
              <p>
                Filled in from your database and storage choices. You do not normally touch these —
                a few marked <b>not set</b> want a value from you, which happens when you bring your
                own database or storage.
              </p>
            </div>
          </div>
          <div className="var-list">
            {provided.map((v) => (
              <EnvVarRow key={v.key} v={v} appSlug={app.slug} deletable={false}
                onChanged={load} onError={setError} onReveal={reveal} onDelete={() => {}} />
            ))}
          </div>
        </>
      )}

      {/* The computed ASTRODOCK_* values were nowhere on this page, so there was
          no way to see what the app is actually handed at run time — its URL, its
          authorize endpoint, the port it must bind. They are derived at deploy
          time rather than stored, which is why they never appeared in this list. */}
      <div className="sec-head" style={{ marginTop: 30 }}>
        <div>
          <h2>Set by the platform</h2>
          <p>
            Computed for every deploy from this app's settings — its address, its port, the
            sign-in endpoints. Read-only, and shown here so you can see exactly what the app
            receives. Secrets among them are masked.
          </p>
        </div>
      </div>
      {runtimeEnv === null ? (
        <p className="hint">Loading…</p>
      ) : runtimeEnv.length === 0 ? (
        <p className="hint">Nothing yet — these appear once the app has been deployed.</p>
      ) : (
        <div className="var-list">
          {runtimeEnv.map(([k, val]) => (
            <div className="var-row is-system" key={k}>
              <div className="var-name"><code>{k}</code></div>
              <div className="var-value"><code className="var-val">{val}</code></div>
              <div className="var-actions" />
            </div>
          ))}
        </div>
      )}

      {showBulk && (
        <div className="modal-overlay" onClick={() => setShowBulk(false)}>
          <form className="modal bulk-modal" onClick={(e) => e.stopPropagation()} noValidate onSubmit={handleBulkImport}>
            <h2>Import variables from a .env file</h2>
            <p className="hint">Paste the contents of a <code>.env</code> file. Lines starting with <code>#</code> are ignored, and Astrodock-managed (<code>ASTRODOCK_</code>) names are skipped.</p>
            {bulkResult && <div className="provision-banner"><strong>{bulkResult.added} variable{bulkResult.added !== 1 ? 's' : ''} imported{bulkResult.skipped > 0 ? `, ${bulkResult.skipped} skipped` : ''}</strong></div>}
            <textarea className="bulk-textarea" value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=sk_live_…\n# comments are ignored'} rows={12} autoFocus />
            <div className="modal-actions">
              <button type="button" onClick={() => { setShowBulk(false); setBulkResult(null); }}>{bulkResult ? 'Done' : 'Cancel'}</button>
              <button type="submit" disabled={!bulkText.trim()}>Import</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
