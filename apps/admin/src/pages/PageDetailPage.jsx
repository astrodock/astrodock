import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../lib/api';

const TEXT_EXTS = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'csv', 'xml', 'svg', 'yml', 'yaml'];
const isText = (n) => TEXT_EXTS.includes((n.split('.').pop() || '').toLowerCase());
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export default function PageDetailPage() {
  const { pageId } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [title, setTitle] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [editing, setEditing] = useState(null); // { name, content }
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();
  const dirRef = useRef();

  async function load() {
    try {
      const { page: p } = await api.getPage(pageId);
      setPage(p); setTitle(p.title || ''); setAllowlist((p.allowlist || []).join('\n'));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [pageId]);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 1800); }
  async function patch(body, note) {
    setError('');
    try { await api.updatePage(pageId, body); await load(); if (note) flash(note); }
    catch (err) { setError(err.message); }
  }

  async function uploadFrom(input) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    setBusy(true); setError('');
    try {
      const paths = files.map((f) => (f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name));
      await api.uploadPageFiles(pageId, files, paths);
      input.value = '';
      await load(); flash(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function openEditor(name) {
    setError('');
    try { const { content } = await api.getPageFileContent(pageId, name); setEditing({ name, content }); }
    catch (err) { setError(err.message); }
  }
  async function saveEditor() {
    setBusy(true); setError('');
    try { await api.savePageFileContent(pageId, editing.name, editing.content); setEditing(null); await load(); flash('Saved.'); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function newFile() {
    const name = prompt('New file name (e.g. index.html or notes.md):');
    if (!name) return;
    try { await api.savePageFileContent(pageId, name, ''); await load(); openEditor(name); }
    catch (err) { setError(err.message); }
  }
  async function removeFile(name) {
    if (!confirm(`Delete "${name}"?`)) return;
    setError('');
    try { await api.deletePageFile(pageId, name); await load(); flash('File deleted.'); }
    catch (err) { setError(err.message); }
  }

  function copy(text, note) { navigator.clipboard?.writeText(text).then(() => flash(note || 'Copied.')); }

  if (!page) return <div>{error ? <div className="error">{error}</div> : 'Loading…'}</div>;

  const keyLink = page.accessMode === 'passkey' && page.passkey ? `${page.url}?key=${encodeURIComponent(page.passkey)}` : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/pages" className="back-link">← Pages</Link>
          <h1 style={{ margin: '4px 0 0' }}>{page.title || 'Untitled'}</h1>
          <span className="row-subtitle">{page.pageId} · {page.views} views</span>
        </div>
        <button className="danger" onClick={async () => { if (confirm('Delete this page and all its files? This cannot be undone.')) { await api.deletePage(pageId); navigate('/pages'); } }}>Delete page</button>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="secret-banner" style={{ padding: '8px 12px' }}>{msg}</div>}

      {/* Share */}
      <div className="card">
        <h2>Share</h2>
        <div className="kv"><span>Link</span>
          <code>{page.url}</code>
          <button className="link-btn" onClick={() => copy(page.url, 'Link copied.')}>copy</button>
          <a href={page.url} target="_blank" rel="noopener" className="app-link">open</a>
          <button className={`toggle-btn ${page.isActive ? 'on' : 'off'}`} onClick={() => patch({ isActive: !page.isActive }, page.isActive ? 'Deactivated.' : 'Activated.')}>
            {page.isActive ? 'Active' : 'Inactive'}
          </button>
        </div>
        {keyLink && (
          <div className="kv"><span>Frictionless link</span>
            <code>{keyLink}</code>
            <button className="link-btn" onClick={() => copy(keyLink, 'Link with key copied.')}>copy</button>
          </div>
        )}
      </div>

      {/* Access */}
      <div className="card">
        <h2>Access</h2>
        <div className="form-row">
          <label>
            Mode
            <select value={page.accessMode} onChange={(e) => patch({ accessMode: e.target.value }, 'Access updated.')}>
              <option value="public">Public</option>
              <option value="passkey">Passkey</option>
              <option value="platform">Platform login</option>
            </select>
          </label>
        </div>
        {page.accessMode === 'passkey' && (
          <>
            <div className="kv"><span>Passkey</span><code>{page.passkey}</code>
              <button className="link-btn" onClick={() => copy(page.passkey, 'Passkey copied.')}>copy</button>
              <button onClick={() => api.generatePagePasskey(pageId).then(load).then(() => flash('Rotated — old links invalid.'))}>Rotate</button>
            </div>
            <div className="kv"><span>Set custom</span>
              <input value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="min 4 chars" />
              <button disabled={customKey.length < 4} onClick={() => { patch({ accessMode: 'passkey', passkey: customKey }, 'Passkey set.'); setCustomKey(''); }}>Save</button>
            </div>
          </>
        )}
        {page.accessMode === 'platform' && (
          <label>
            Allowed emails (one per line — empty = any active user)
            <textarea rows={3} value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder="alice@example.com" />
            <button style={{ marginTop: 6 }} onClick={() => patch({ allowlist: allowlist.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) }, 'Allowlist saved.')}>Save allowlist</button>
          </label>
        )}
      </div>

      {/* Saved data */}
      <div className="card">
        <h2>Saved data</h2>
        <p className="hint">A small JSON blob your page reads/writes at <code>{page.url}_data</code> (≤ 1 MB). Writes require a passkey or login.</p>
        <label>
          Mode
          <select value={page.dataMode} onChange={(e) => patch({ dataMode: e.target.value }, 'Data mode updated.')}>
            <option value="none">Off</option>
            <option value="shared" disabled={page.accessMode === 'public'}>Shared (one blob)</option>
            <option value="per-user" disabled={page.accessMode !== 'platform'}>Per-user (needs platform login)</option>
          </select>
        </label>
      </div>

      {/* Files */}
      <div className="card">
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Files</h2>
          <div className="modal-actions" style={{ margin: 0 }}>
            <button onClick={newFile}>New text file</button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}>Upload files</button>
            <button onClick={() => dirRef.current?.click()} disabled={busy}>Upload folder</button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => uploadFrom(e.target)} />
            <input ref={dirRef} type="file" multiple webkitdirectory="" directory="" hidden onChange={(e) => uploadFrom(e.target)} />
          </div>
        </div>
        {(page.files || []).length === 0 ? (
          <p className="empty-state">No files yet. Upload some, or create a text file.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Entry</th><th>Actions</th></tr></thead>
            <tbody>
              {page.files.map((f) => (
                <tr key={f.name}>
                  <td><code>{f.name}</code></td>
                  <td className="text-muted">{f.contentType?.split(';')[0]}</td>
                  <td>{fmtSize(f.size)}</td>
                  <td>{f.name === page.entryFile
                    ? <span className="pill">entry</span>
                    : <button className="link-btn" onClick={() => patch({ entryFile: f.name }, 'Entry set.')}>set entry</button>}</td>
                  <td className="actions">
                    {isText(f.name) && <button className="link-btn" onClick={() => openEditor(f.name)}>edit</button>}
                    <button className="danger" onClick={() => removeFile(f.name)}>delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Edit <code>{editing.name}</code></h2>
            <textarea className="code-editor" value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} spellCheck={false} />
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button onClick={saveEditor} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
