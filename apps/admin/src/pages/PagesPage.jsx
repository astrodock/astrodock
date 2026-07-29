import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';

const BLANK = { title: '', accessMode: 'public', dataMode: 'none', passkeyMode: 'generate', passkey: '' };

export default function PagesPage() {
  const [pages, setPages] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const navigate = useNavigate();

  async function load() {
    try { setPages((await api.getPages()).pages || []); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError(''); setCreating(true);
    try {
      const body = { title: draft.title || 'Untitled', accessMode: draft.accessMode, dataMode: draft.dataMode };
      if (draft.accessMode === 'passkey') {
        if (draft.passkeyMode === 'custom' && draft.passkey) body.passkey = draft.passkey;
        else body.generatePasskey = true;
      }
      const data = await api.createPage(body);
      setShowCreate(false); setDraft(BLANK);
      navigate(`/pages/${data.page.pageId}`);
    } catch (err) { setError(err.message); }
    finally { setCreating(false); }
  }

  async function toggleActive(e, p) {
    e.stopPropagation();
    try { await api.updatePage(p.pageId, { isActive: !p.isActive }); load(); }
    catch (err) { setError(err.message); }
  }

  function copyLink(e, url, id) {
    e.stopPropagation();
    navigator.clipboard?.writeText(url).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); });
  }

  // data modes require a gate; reflect the allowed combos in the create form
  const dataModes = draft.accessMode === 'public'
    ? [['none', 'None']]
    : draft.accessMode === 'passkey'
      ? [['none', 'None'], ['shared', 'Shared (one blob)']]
      : [['none', 'None'], ['shared', 'Shared (one blob)'], ['per-user', 'Per-user']];

  return (
    <div>
      <div className="page-header">
        <h1>Pages</h1>
        <p className="page-sub">Lightweight documents and mini-sites hosted without a full app — docs, notes, a landing page.</p>
        <button onClick={() => setShowCreate(true)}>New Page</button>
      </div>

      <p className="hint">
        Pages host one-off documents, static mini-sites, and file shares — no repo, build, or deploy.
        Publish from the <code>astrodock pages push</code> CLI or here. Add a passkey or platform login to gate access.
      </p>

      {error && <div className="error">{error}</div>}

      {pages.length === 0 ? (
        <EmptyState icon="pages" title="No Pages Yet"
          body="A page is a lightweight document or mini-site hosted without a full app — handy for docs, notes or a landing page. You can also run: astrodock pages push ./dir" />
      ) : (
        <table className="data-table clickable">
          <thead>
            <tr><th>Title</th><th>Link</th><th>Access</th><th>Data</th><th>Views</th><th>Status</th></tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.pageId} onClick={() => navigate(`/pages/${p.pageId}`)}>
                <td><strong>{p.title || 'Untitled'}</strong><span className="row-subtitle">{p.pageId}</span></td>
                <td>
                  <a href={p.url} className="app-link" target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>open</a>
                  <button className="link-btn" style={{ marginLeft: 8 }} onClick={(e) => copyLink(e, p.url, p.pageId)}>
                    {copied === p.pageId ? 'copied!' : 'copy'}
                  </button>
                </td>
                <td><span className="pill">{p.accessMode}</span></td>
                <td>{p.dataMode === 'none' ? <span className="text-muted">—</span> : <span className="pill">{p.dataMode}</span>}</td>
                <td>{p.views}</td>
                <td>
                  <button className={`toggle-btn ${p.isActive ? 'on' : 'off'}`} onClick={(e) => toggleActive(e, p)}>
                    {p.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={(e) = noValidate> e.stopPropagation()} onSubmit={handleCreate}>
            <h2>New Page</h2>
            {error && <div className="error">{error}</div>}
            <label>
              Title
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Q3 Dashboard" autoFocus />
            </label>
            <div className="form-row">
              <label>
                Access
                <select value={draft.accessMode} onChange={(e) => setDraft({ ...draft, accessMode: e.target.value, dataMode: 'none' })}>
                  <option value="public">Public</option>
                  <option value="passkey">Passkey</option>
                  <option value="platform">Platform login</option>
                </select>
              </label>
              <label>
                Saved Data
                <select value={draft.dataMode} onChange={(e) => setDraft({ ...draft, dataMode: e.target.value })}>
                  {dataModes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            {draft.accessMode === 'passkey' && (
              <div className="form-row">
                <label>
                  Passkey
                  <select value={draft.passkeyMode} onChange={(e) => setDraft({ ...draft, passkeyMode: e.target.value })}>
                    <option value="generate">Generate one</option>
                    <option value="custom">Set my own</option>
                  </select>
                </label>
                {draft.passkeyMode === 'custom' && (
                  <label>
                    Custom Passkey
                    <input value={draft.passkey} onChange={(e) => setDraft({ ...draft, passkey: e.target.value })} placeholder="min 4 chars" minLength={4} />
                  </label>
                )}
              </div>
            )}
            <p className="hint">You’ll upload files (or paste content) on the next screen. Saved data needs a passkey or platform login.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
