import { Fragment, useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import Select from '../components/Select';
import useConfirm from '../lib/useConfirm';

// One artifact: its files, who it is shared with, its data, the manifest that
// declares that data, and its settings.

const TABS = [['files', 'Files'], ['sharing', 'Sharing'], ['data', 'Data'], ['activity', 'Activity'], ['errors', 'Errors'], ['manifest', 'Manifest'], ['settings', 'Settings']];
const TEXT = /\.(html?|css|m?js|json|txt|md|csv|xml|svg|ya?ml)$/i;
const DEFAULT_ROLES = ['owner', 'editor', 'viewer'];

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function when(d) {
  return d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}

export default function ArtifactDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [confirmNode, ask] = useConfirm();
  const [artifact, setArtifact] = useState(null);
  const [folders, setFolders] = useState([]);
  const [tab, setTab] = useState('files');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const notes = (useLocation().state || {}).notes || [];

  async function load() {
    try { setArtifact((await api.getArtifact(id)).artifact); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); api.getArtifactFolders().then((r) => setFolders(r.folders || [])).catch(() => {}); }, [id]);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 2000); }
  async function patch(body, note) {
    setError('');
    try { const r = await api.updateArtifact(id, body); setArtifact((a) => ({ ...a, ...r.artifact })); if (note) flash(note); return r; }
    catch (err) { setError(err.message); throw err; }
  }

  if (!artifact) return <div>{error ? <div className="error">{error}</div> : 'Loading…'}</div>;
  const roles = (artifact.manifest && artifact.manifest.roles) || DEFAULT_ROLES;

  return (
    <>
      {confirmNode}
      <div>
        <div className="page-header">
          <div>
            <Link to="/artifacts" className="back-link">← Artifacts</Link>
            <h1 style={{ margin: '4px 0 0' }}>{artifact.title || 'Untitled'}</h1>
            <span className="row-subtitle">{artifact.id} · {artifact.visibility === 'public' ? 'Public' : 'Shared by Email'}{artifact.suspended ? ' · Taken Down' : ''}</span>
          </div>
          <div className="btn-row">
            <button onClick={() => navigator.clipboard?.writeText(artifact.url).then(() => flash('Link copied.'))}>Copy Link</button>
            <a className="btnlike" href={artifact.url} target="_blank" rel="noopener">Open ↗</a>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {msg && <div className="flash-line" role="status">{msg}</div>}
        {notes.length > 0 && <ul className="plain-list flash-line">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}

        <div className="tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        <div className="tab-content">
          {tab === 'files' && <FilesTab artifact={artifact} reload={load} setError={setError} flash={flash} ask={ask} patch={patch} />}
          {tab === 'sharing' && <SharingTab artifact={artifact} roles={roles} reload={load} setError={setError} flash={flash} ask={ask} />}
          {tab === 'data' && <DataTab artifact={artifact} setError={setError} ask={ask} />}
          {tab === 'activity' && <ActivityTab artifact={artifact} setError={setError} />}
          {tab === 'errors' && <ErrorsTab artifact={artifact} setError={setError} ask={ask} />}
          {tab === 'manifest' && <ManifestTab artifact={artifact} patch={patch} />}
          {tab === 'settings' && (
            <SettingsTab artifact={artifact} folders={folders} patch={patch} ask={ask} flash={flash}
              onDelete={async () => { await api.deleteArtifact(id); navigate('/artifacts'); }} />
          )}
        </div>
      </div>
    </>
  );
}

function FilesTab({ artifact, reload, setError, flash, ask, patch }) {
  const input = useRef(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  async function upload(list) {
    if (!list || !list.length) return;
    setBusy(true); setError('');
    try {
      const files = [...list];
      // A folder upload carries each file's path under the chosen folder.
      const paths = files.map((f) => (f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name));
      await api.uploadArtifactFiles(artifact.id, files, paths);
      await reload();
      flash(`${files.length} file${files.length === 1 ? '' : 's'} uploaded.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  async function open(name) {
    setError('');
    try { const r = await api.getArtifactFile(artifact.id, name); setEditing({ name, content: r.content }); }
    catch (err) { setError(err.message); }
  }
  async function save() {
    setBusy(true); setError('');
    try { await api.saveArtifactFiles(artifact.id, [{ name: editing.name, content: editing.content }]); setEditing(null); await reload(); flash('Saved.'); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div>
        <div className="tab-header">
          <h2>{editing.name}</h2>
          <div className="btn-row">
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <textarea className="code-editor" spellCheck={false} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
      </div>
    );
  }

  const files = artifact.files || [];
  return (
    <div>
      <div className="tab-header">
        <h2>Files</h2>
        <div className="btn-row">
          <button onClick={() => setEditing({ name: 'new-file.html', content: '' })}>New File</button>
          <button className="primary" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload Files'}</button>
          <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
      </div>
      <p className="hint">The entry file, <code>{artifact.entryFile}</code>, is what opens at the artifact's address. Pages load the data client with <code>&lt;script src="/_astrodock/client.js"&gt;&lt;/script&gt;</code>.</p>
      {files.length === 0 ? (
        <EmptyState icon="pages" title="No Files Yet" body="Upload the artifact's HTML, CSS and JavaScript, or ask your AI agent to." />
      ) : (
        <table className="data-table">
          <thead><tr><th>Name</th><th>Size</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td><strong>{f.name}</strong>{f.name === artifact.entryFile && <span className="row-subtitle">Entry File</span>}</td>
                <td>{size(f.size)}</td>
                <td>{when(f.updatedAt)}</td>
                <td className="row-actions">
                  {TEXT.test(f.name) && <button className="link-btn" onClick={() => open(f.name)}>Edit</button>}
                  {f.name !== artifact.entryFile && /\.html?$/i.test(f.name) && (
                    <button className="link-btn" onClick={() => patch({ entryFile: f.name }, 'Entry file changed.')}>Make Entry File</button>
                  )}
                  <button className="link-btn danger" onClick={() => ask({
                    title: `Delete ${f.name}?`, danger: true, confirmLabel: 'Delete File',
                    body: <p>The file is removed from the artifact.</p>,
                    onConfirm: async () => { await api.deleteArtifactFile(artifact.id, f.name); await reload(); }
                  })}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SharingTab({ artifact, roles, reload, setError, flash, ask }) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState(roles[roles.length - 1]);
  const [busy, setBusy] = useState(false);
  const shares = artifact.shares || [];

  async function share(e) {
    e.preventDefault();
    const list = emails.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true); setError('');
    try {
      const r = await api.shareArtifact(artifact.id, list, role);
      setEmails('');
      await reload();
      const capped = r.results.filter((x) => x.invite === 'capped').length;
      flash(capped ? `Shared. ${capped} invitation${capped === 1 ? ' was' : 's were'} not sent: the daily limit is reached.` : 'Shared. Invitations sent.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="tab-header"><h2>Sharing</h2></div>
      <form className="share-form" onSubmit={share} noValidate>
        <label className="grow">
          Email Addresses
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="sam@example.com, lee@example.com" />
        </label>
        <label>
          Role
          <Select value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))} />
        </label>
        <button type="submit" className="primary" disabled={busy || !emails.trim()}>{busy ? 'Sharing…' : 'Share'}</button>
      </form>
      <p className="hint">Each person gets an email with the link and signs in with a code sent to their address. People on this Astrodock account are signed in without a code. Roles come from the manifest.</p>
      {shares.length === 0 ? (
        <EmptyState icon="users" title="Not Shared Yet" body="Only you can open this artifact until you share it." />
      ) : (
        <table className="data-table">
          <thead><tr><th>Email</th><th>Role</th><th>Shared</th><th></th></tr></thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.email}>
                <td><strong>{s.email}</strong></td>
                <td>
                  <Select value={s.role} onChange={async (v) => {
                    try { await api.shareArtifact(artifact.id, [s.email], v, false); await reload(); flash('Role changed.'); }
                    catch (err) { setError(err.message); }
                  }} options={roles.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))} />
                </td>
                <td>{when(s.createdAt)}</td>
                <td className="row-actions">
                  <button className="link-btn danger" onClick={() => ask({
                    title: `Remove ${s.email}?`, danger: true, confirmLabel: 'Remove',
                    body: <p>They lose access right away, including any page they have open.</p>,
                    onConfirm: async () => { await api.unshareArtifact(artifact.id, s.email); await reload(); }
                  })}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DataTab({ artifact, setError, ask }) {
  const [summary, setSummary] = useState(null);
  const [collection, setCollection] = useState('');
  const [records, setRecords] = useState(null);
  const [history, setHistory] = useState(null); // { recordId, entries }
  const declared = Object.keys((artifact.manifest && artifact.manifest.collections) || {});

  useEffect(() => { api.getArtifactData(artifact.id).then(setSummary).catch((err) => setError(err.message)); }, [artifact.id]);
  useEffect(() => {
    if (!collection) { setRecords(null); return; }
    api.getArtifactRecords(artifact.id, collection).then((r) => setRecords(r.records)).catch((err) => setError(err.message));
  }, [collection, artifact.id]);

  const names = [...new Set([...declared, ...Object.keys((summary && summary.collections) || {})])];
  const columns = records ? [...new Set(records.flatMap((r) => Object.keys(r.data || {})))].slice(0, 8) : [];
  const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return (
    <div>
      <div className="tab-header"><h2>Data</h2></div>
      {names.length === 0 ? (
        <EmptyState icon="pages" title="No Collections" body="Collections are declared in the manifest. Records appear here as people use the artifact." />
      ) : (
        <div className="folder-layout">
          <nav className="folder-nav" aria-label="Collections">
            <ul>
              {names.map((n) => (
                <li key={n}>
                  <button type="button" className={`folder-link${collection === n ? ' active' : ''}`} onClick={() => setCollection(n)}>
                    <span>{n}</span><span className="folder-count">{(summary && summary.collections[n]) || 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section className="folder-main">
            {!collection ? <p className="hint">Choose a collection to see its records.</p>
              : !records ? <p className="hint">Loading…</p>
                : records.length === 0 ? <EmptyState icon="pages" title="No Records" body="Nothing has been added to this collection yet." />
                  : (
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}<th>Author</th><th>Updated</th><th></th></tr></thead>
                        <tbody>
                          {records.map((r) => (
                            <tr key={r.id}>
                              {columns.map((c) => <td key={c}>{cell(r.data[c]).slice(0, 120)}</td>)}
                              <td>{r.author}</td>
                              <td>{when(r.updatedAt)}</td>
                              <td className="row-actions">
                                <button className="link-btn" onClick={async () => {
                                  try { setHistory({ recordId: r.id, entries: (await api.getArtifactHistory(artifact.id, r.id)).history }); }
                                  catch (err) { setError(err.message); }
                                }}>History</button>
                                <button className="link-btn danger" onClick={() => ask({
                                  title: 'Delete This Record?', danger: true, confirmLabel: 'Delete Record',
                                  body: <p>The record is removed for everyone. There is no undo.</p>,
                                  onConfirm: async () => {
                                    await api.deleteArtifactRecord(artifact.id, collection, r.id);
                                    setRecords((rs) => rs.filter((x) => x.id !== r.id));
                                  }
                                })}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {history && <HistoryList history={history} onClose={() => setHistory(null)} />}
                    </div>
                  )}
          </section>
        </div>
      )}
    </div>
  );
}

function ManifestTab({ artifact, patch }) {
  const [text, setText] = useState(JSON.stringify(artifact.manifest || {}, null, 2));
  const [problems, setProblems] = useState([]);
  const [parseError, setParseError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);

  async function save() {
    setProblems([]); setParseError(''); setWarnings([]);
    let manifest;
    try { manifest = JSON.parse(text); } catch (err) { setParseError(`Not valid JSON: ${err.message}`); return; }
    setBusy(true);
    try {
      const r = await patch({ manifest }, 'Manifest saved.');
      setWarnings(r.warnings || []);
    } catch (err) {
      setProblems((err.body && err.body.problems) || []);
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="tab-header">
        <h2>Manifest</h2>
        <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <p className="hint">Roles, collections, blobs and actions. The format is in the agent guide at <code>/admin/artifacts/guide</code>.</p>
      {parseError && <div className="error">{parseError}</div>}
      {problems.length > 0 && (
        <div className="error"><ul className="plain-list">{problems.map((p, i) => <li key={i}><code>{p.path}</code> {p.message}</li>)}</ul></div>
      )}
      {warnings.length > 0 && <ul className="plain-list hint">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      <textarea className="code-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}

function SettingsTab({ artifact, folders, patch, ask, flash, onDelete }) {
  const [title, setTitle] = useState(artifact.title || '');
  return (
    <div className="settings-stack">
      <section className="settings-sec">
        <h2>Title</h2>
        <form className="share-form" onSubmit={(e) => { e.preventDefault(); patch({ title }, 'Title saved.').catch(() => {}); }}>
          <label className="grow">Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <button type="submit" disabled={!title.trim() || title === artifact.title}>Save</button>
        </form>
      </section>

      <section className="settings-sec">
        <h2>Folder</h2>
        <Select value={artifact.folderId || ''} onChange={(v) => patch({ folderId: v || null }, 'Moved.').catch(() => {})}
          options={[{ value: '', label: 'No Folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />
      </section>

      <section className="settings-sec">
        <h2>Visibility</h2>
        <Select value={artifact.visibility} onChange={(v) => patch({ visibility: v }, 'Visibility changed.').catch(() => {})} options={[
          { value: 'shared', label: 'Shared by Email', description: 'Only people on the share list, after signing in.' },
          { value: 'public', label: 'Public', description: 'Anyone with the link. Only rules that include "public" apply to them, and only for reading.' }
        ]} />
      </section>

      <section className="settings-sec">
        <h2>Sessions</h2>
        <p className="hint">Sign everyone out of this artifact. They keep their access and sign in again.</p>
        <button onClick={() => ask({
          title: 'Sign Everyone Out?', confirmLabel: 'Sign Everyone Out',
          body: <p>Every open session on this artifact ends, including yours.</p>,
          onConfirm: async () => { await api.revokeArtifactSessions(artifact.id); flash('Everyone was signed out.'); }
        })}>Sign Everyone Out</button>
      </section>

      <section className="settings-sec">
        <h2>Status</h2>
        <p className="hint">{artifact.isActive ? 'The artifact is on.' : 'The artifact is off. Its address shows Not Found.'}</p>
        <button onClick={() => patch({ isActive: !artifact.isActive }, artifact.isActive ? 'Turned off.' : 'Turned on.').catch(() => {})}>
          {artifact.isActive ? 'Turn Off' : 'Turn On'}
        </button>
      </section>

      <section className="settings-sec">
        <h2>Delete</h2>
        <p className="hint">Removes the artifact, its files, its data and its share list.</p>
        <button className="danger" onClick={() => ask({
          title: 'Delete This Artifact?', danger: true, confirmLabel: 'Delete Artifact', typeToConfirm: artifact.id,
          body: <><p>The artifact, every file, every record and the share list are removed. Its address stops working.</p><p className="hint">There is no undo.</p></>,
          onConfirm: onDelete
        })}>Delete Artifact</button>
      </section>
    </div>
  );
}

const SIGNIN_LABEL = {
  silent: 'Signed In (Account)', code_sent: 'Code Sent', code_no_access: 'Code Requested, No Access', code_capped: 'Code Limit Reached',
  code_no_email: 'Email Not Set Up', code_wrong: 'Wrong or Expired Code', code_ok: 'Code Accepted', account_off: 'Account Turned Off',
  grant_ok: 'Signed In', grant_failed: 'Sign-In Link Expired'
};

function HistoryList({ history, onClose }) {
  const show = (v) => (v == null ? '' : JSON.stringify(v, null, 1));
  return (
    <section className="settings-sec">
      <div className="tab-header" style={{ width: '100%' }}>
        <h2>History of {history.recordId.slice(0, 8)}</h2>
        <button className="link-btn" onClick={onClose}>Close</button>
      </div>
      {history.entries.length === 0 ? <p className="hint">No changes recorded in the retention window.</p> : (
        <table className="data-table">
          <thead><tr><th>When</th><th>Who</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {history.entries.map((h) => (
              <tr key={h.id}>
                <td>{when(h.createdAt)}</td>
                <td>{h.actor}</td>
                <td>{h.action[0].toUpperCase() + h.action.slice(1)}</td>
                <td><pre className="mono-cell">{show(h.before)}</pre></td>
                <td><pre className="mono-cell">{show(h.after)}</pre></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function bytes(n) {
  if (!n) return '0 B';
  return size(n);
}

function ActivityTab({ artifact, setError }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('views');
  const [entries, setEntries] = useState(null);
  const [person, setPerson] = useState('');

  useEffect(() => { api.getArtifactUsage(artifact.id).then(setData).catch((err) => setError(err.message)); }, [artifact.id]);
  useEffect(() => {
    setEntries(null);
    api.getArtifactActivity(artifact.id, kind, person).then((r) => setEntries(r.entries)).catch((err) => setError(err.message));
  }, [artifact.id, kind, person]);

  if (!data) return <p className="hint">Loading…</p>;
  const u = data.usage;
  const stats = [
    ['Views', u.views30, '30 days'], ['People', u.people30, '30 days'], ['Changes', u.writes30, '30 days'],
    ['Reads', u.reads30, '30 days'], ['Records', u.records, 'now'], ['Storage', bytes(u.storageBytes), 'files and data'],
    ['Emails Sent', u.emails30, '30 days'], ['Errors', u.errors7, '7 days']
  ];
  return (
    <div>
      <div className="stat-strip">
        {stats.map(([label, value, note]) => (
          <div key={label} className="stat-cell"><span className="stat-label">{label}</span><strong>{value}</strong><span className="stat-note">{note}</span></div>
        ))}
      </div>

      <div className="tab-header"><h2>People</h2></div>
      <table className="data-table clickable">
        <thead><tr><th>Email</th><th>Role</th><th>Last Seen</th><th>Views (30 Days)</th><th>Changes (30 Days)</th></tr></thead>
        <tbody>
          {data.people.map((p) => (
            <tr key={p.email} onClick={() => setPerson(person === p.email ? '' : p.email)} className={person === p.email ? 'selected' : ''}>
              <td><strong>{p.email}</strong></td>
              <td>{p.role ? p.role[0].toUpperCase() + p.role.slice(1) : 'No Longer Shared'}</td>
              <td>{p.lastSeen ? when(p.lastSeen) : 'Never'}</td>
              <td>{p.views30}</td>
              <td>{p.writes30}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tab-header" style={{ marginTop: 24 }}>
        <h2>Recent {person ? `for ${person}` : 'Activity'}</h2>
        <div className="btn-row">
          {person && <button className="link-btn" onClick={() => setPerson('')}>Everyone</button>}
          <Select value={kind} onChange={setKind} options={[
            { value: 'views', label: 'Page Views' }, { value: 'api', label: 'Changes and Failures' }, { value: 'signins', label: 'Sign-In Attempts' }
          ]} />
        </div>
      </div>
      {!entries ? <p className="hint">Loading…</p> : entries.length === 0 ? <p className="hint">Nothing recorded yet.</p> : (
        <div className="table-scroll">
          <table className="data-table">
            {kind === 'views' && <>
              <thead><tr><th>When</th><th>Who</th><th>Page</th><th>Result</th><th>Address</th></tr></thead>
              <tbody>{entries.map((e) => (
                <tr key={e.id}><td>{when(e.createdAt)}</td><td>{e.email || 'Not Signed In'}</td><td><code>{e.path}</code></td>
                  <td>{e.status === 302 ? 'Sent to Sign In' : e.status}</td><td className="text-muted">{e.ip}</td></tr>
              ))}</tbody>
            </>}
            {kind === 'api' && <>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Result</th><th>Detail</th></tr></thead>
              <tbody>{entries.map((e) => (
                <tr key={e.id}><td>{when(e.createdAt)}</td><td>{e.email || 'Not Signed In'}</td>
                  <td><code>{e.op}{e.target ? ` ${e.target}` : ''}</code></td><td>{e.status}</td><td className="text-muted">{e.error}</td></tr>
              ))}</tbody>
            </>}
            {kind === 'signins' && <>
              <thead><tr><th>When</th><th>Email</th><th>Result</th><th>Address</th></tr></thead>
              <tbody>{entries.map((e) => (
                <tr key={e.id}><td>{when(e.createdAt)}</td><td>{e.email}</td><td>{SIGNIN_LABEL[e.result] || e.result}</td><td className="text-muted">{e.ip}</td></tr>
              ))}</tbody>
            </>}
          </table>
        </div>
      )}
    </div>
  );
}

const ERROR_KIND = { error: 'Script Error', rejection: 'Unhandled Promise', console: 'Console Error', network: 'Failed Request', api: 'Data Call Failed', server: 'Server Error' };

function ErrorsTab({ artifact, setError, ask }) {
  const [errors, setErrors] = useState(null);
  const [reports, setReports] = useState([]);
  const [open, setOpen] = useState('');
  async function load() {
    try {
      const [e, r] = await Promise.all([api.getArtifactErrors(artifact.id), api.getArtifactReports(artifact.id)]);
      setErrors(e.errors); setReports(r.reports);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [artifact.id]);
  if (!errors) return <p className="hint">Loading…</p>;
  return (
    <div>
      <div className="tab-header">
        <h2>Errors</h2>
        {errors.length > 0 && <button onClick={() => ask({
          title: 'Clear the Error List?', confirmLabel: 'Clear',
          body: <p>Do this once the page is fixed, so anything that shows up afterward is new.</p>,
          onConfirm: async () => { await api.clearArtifactErrors(artifact.id); await load(); }
        })}>Clear</button>}
      </div>
      <p className="hint">From the page itself (script errors, failed requests) and from data calls the server refused. Agents read the same list at <code>/admin/artifacts/{artifact.id}/errors</code>.</p>
      {errors.length === 0 ? <EmptyState icon="activity" title="No Errors" body="Nothing has gone wrong in this artifact in the retention window." /> : (
        <table className="data-table clickable">
          <thead><tr><th>Error</th><th>Kind</th><th>Times</th><th>People</th><th>Last Seen</th></tr></thead>
          <tbody>
            {errors.map((e) => (
              <Fragment key={e.id}>
                <tr onClick={() => setOpen(open === e.id ? '' : e.id)}>
                  <td><strong>{e.message.slice(0, 160)}</strong>{e.source && <span className="row-subtitle">{e.source}</span>}</td>
                  <td>{ERROR_KIND[e.kind] || e.kind}</td>
                  <td>{e.count}</td>
                  <td>{e.people}</td>
                  <td>{when(e.lastSeen)}</td>
                </tr>
                {open === e.id && (
                  <tr className="detail-row"><td colSpan={5}>
                    <dl className="err-detail">
                      <dt>Page</dt><dd><code>{e.path || 'Unknown'}</code></dd>
                      <dt>First Seen</dt><dd>{when(e.firstSeen)}</dd>
                      <dt>People</dt><dd>{e.emails.join(', ') || 'Not signed in'}</dd>
                      <dt>Browser</dt><dd className="text-muted">{e.userAgent}</dd>
                    </dl>
                    {e.stack && <pre className="mono-cell">{e.stack}</pre>}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <div className="tab-header" style={{ marginTop: 24 }}><h2>Problem Reports</h2></div>
      {reports.length === 0 ? <p className="hint">Nobody has used Report a Problem on this artifact.</p> : (
        <table className="data-table">
          <thead><tr><th>Report</th><th>From</th><th>When</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className={r.status === 'closed' ? 'inactive' : ''}>
                <td>{r.message}{r.kind === 'abuse' && <span className="row-subtitle">Reported as Harmful</span>}</td>
                <td>{r.email || 'Not Signed In'}</td>
                <td>{when(r.createdAt)}</td>
                <td>{r.status === 'open' ? 'Open' : 'Closed'}</td>
                <td className="row-actions">
                  <button className="link-btn" onClick={async () => { try { await api.setArtifactReport(r.id, r.status === 'open' ? 'closed' : 'open'); await load(); } catch (err) { setError(err.message); } }}>
                    {r.status === 'open' ? 'Close' : 'Reopen'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
