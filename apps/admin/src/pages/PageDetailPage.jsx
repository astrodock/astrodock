import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../lib/api';
import PageFiles from '../components/PageFiles';

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
  const [views, setViews] = useState(null);
  const [reissue, setReissue] = useState(false);

  async function load() {
    try {
      const { page: p } = await api.getPage(pageId);
      setPage(p); setTitle(p.title || ''); setAllowlist((p.allowlist || []).join('\n'));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [pageId]);
  useEffect(() => { api.getPageViews(pageId).then(setViews).catch(() => {}); }, [pageId]);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 1800); }
  async function patch(body, note) {
    setError('');
    try { await api.updatePage(pageId, body); await load(); if (note) flash(note); }
    catch (err) { setError(err.message); }
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
        <button className="danger" onClick={async () => { if (confirm('Delete this page and all its files? This cannot be undone.')) { await api.deletePage(pageId); navigate('/pages'); } }}>Delete Page</button>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="secret-banner" style={{ padding: '8px 12px' }}>{msg}</div>}

      {/* Share */}
      <div className="card">
        <div className="sec-head" style={{ marginBottom: 12 }}>
          <div>
            <h2>Share</h2>
            <p>Where this page lives, and whether it answers at all.</p>
          </div>
          <span className={`chip ${page.isActive ? 'ok' : 'warn'}`}>
            {page.isActive ? 'Published' : 'Unpublished'}
          </span>
        </div>

        <div className="linkbar">
          <code>{page.url}</code>
          <button onClick={() => copy(page.url, 'Link copied.')}>Copy</button>
          <a className="btnlike" href={page.url} target="_blank" rel="noopener">Open ↗</a>
        </div>

        {keyLink && (
          <>
            <p className="hint" style={{ marginTop: 14, marginBottom: 6 }}>
              With the passkey built in — anyone holding this link gets straight in, no prompt.
            </p>
            <div className="linkbar">
              <code>{keyLink}</code>
              <button onClick={() => copy(keyLink, 'Link with key copied.')}>Copy</button>
              <a className="btnlike" href={keyLink} target="_blank" rel="noopener">Open ↗</a>
            </div>
          </>
        )}

        <div className="opt-list" style={{ marginTop: 16 }}>
          <div className={`opt-row ${page.isActive ? 'on' : ''}`}>
            <span className="name">
              <b>Published</b>
              <span className="opt-desc">
                Unpublished, the address returns 404 for everyone — including anyone holding a link,
                and including you. Nothing is deleted; switch it back on and it returns.
              </span>
            </span>
            <span className={`mini-toggle ${page.isActive ? 'on' : ''}`} role="switch" aria-checked={page.isActive}
              aria-label="Published"
              onClick={() => patch({ isActive: !page.isActive }, page.isActive ? 'Unpublished — the address now 404s.' : 'Published.')} />
          </div>
        </div>

        <div className="sec-head" style={{ marginTop: 20, marginBottom: 8 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>Change the address</h3>
            <p>
              Gives this page a brand-new id and moves its files across. Every link anyone
              already has stops working — which is the point, if one went further than you meant.
            </p>
          </div>
          <button className="danger" onClick={() => setReissue(true)}>New Address</button>
        </div>
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
            <button style={{ marginTop: 6 }} onClick={() => patch({ allowlist: allowlist.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) }, 'Allowlist saved.')}>Save Allowlist</button>
          </label>
        )}
      </div>

      {/* Saved data */}
      <div className="card">
        <h2>Saved Data</h2>
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

      {/* Analytics */}
      {views && (
        <div className="card">
          <div className="sec-head" style={{ marginBottom: 12 }}>
            <div>
              <h2>Analytics</h2>
              <p>
                Every request is logged, not just page loads — a stylesheet or an image counts as
                an access. The split below keeps the two apart.
              </p>
            </div>
          </div>

          <div className="stat-row">
            <div className="stat"><b>{views.views}</b><span>Page loads, all time</span></div>
            <div className="stat"><b>{views.uniqueIps}</b><span>Distinct visitors seen</span></div>
            <div className="stat"><b>{views.last7d}</b><span>Requests, last 7 days</span></div>
          </div>

          {views.breakdown && (
            <div className="opt-list" style={{ marginTop: 14 }}>
              <div className="opt-row">
                <span className="name">Page loads<code>{views.entryFile}</code></span>
                <span className="mono">{views.breakdown.loads}</span>
              </div>
              <div className="opt-row">
                <span className="name">
                  <b>Sub-resources</b>
                  <span className="opt-desc">
                    Stylesheets, scripts, images and anything else the page pulls in after it loads.
                  </span>
                </span>
                <span className="mono">{views.breakdown.assets}</span>
              </div>
              {views.breakdown.notFound > 0 && (
                <div className="opt-row">
                  <span className="name" style={{ color: 'var(--danger)' }}>Not found</span>
                  <span className="mono">{views.breakdown.notFound}</span>
                </div>
              )}
              {views.breakdown.denied > 0 && (
                <div className="opt-row">
                  <span className="name" style={{ color: 'var(--warning)' }}>Turned away</span>
                  <span className="mono">{views.breakdown.denied}</span>
                </div>
              )}
            </div>
          )}

          {views.topMissing?.length > 0 && (
            <>
              <p className="hint" style={{ marginTop: 14, marginBottom: 6 }}>
                <b>Requested but missing.</b> Usually a file the page links to that was never uploaded.
              </p>
              <div className="opt-list">
                {views.topMissing.map((m) => (
                  <div className="opt-row" key={m.key}>
                    <span className="name mono" style={{ color: 'var(--danger)' }}>{m.key || '(root)'}</span>
                    <span className="mono">{m.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {views.topPaths?.length > 0 && (
            <>
              <p className="hint" style={{ marginTop: 14, marginBottom: 6 }}>Most requested</p>
              <div className="opt-list">
                {views.topPaths.map((t) => (
                  <div className="opt-row" key={t.key}>
                    <span className="name mono">{t.key || '(root)'}</span>
                    <span className="mono">{t.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {views.topReferrers?.length > 0 && (
            <>
              <p className="hint" style={{ marginTop: 14, marginBottom: 6 }}>Came from</p>
              <div className="opt-list">
                {views.topReferrers.map((r) => (
                  <div className="opt-row" key={r.key}>
                    <span className="name mono">{r.key}</span>
                    <span className="mono">{r.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="hint" style={{ marginTop: 14 }}>
            From the last {views.sampleSize} logged requests. How much of a visitor's IP is kept —
            or whether any is — is set under Settings → Logs &amp; Privacy.
          </p>
        </div>
      )}

      <PageFiles
        page={page}
        pageId={pageId}
        onChanged={async (body, note) => { if (body) await patch(body, note); else await load(); }}
        onEdit={openEditor}
        onError={setError}
        flash={flash}
      />

      {reissue && (
        <ReissueModal
          page={page}
          onClose={() => setReissue(false)}
          onDone={(res) => {
            setReissue(false);
            navigate(`/pages/${res.page.pageId}`, { replace: true });
            flash(`New address issued. ${res.previousPageId} no longer resolves.`);
          }}
          onError={setError}
        />
      )}

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

function ReissueModal({ page, onClose, onDone, onError }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = typed.trim() === page.pageId;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        try { onDone(await api.reissuePageId(page.pageId)); }
        catch (err) { onError(err.message); setBusy(false); }
      }}>
        <h2>Give This Page a New Address</h2>

        <div className="rcard crit" style={{ marginBottom: 14 }}>
          <span className="led crit" />
          <span>
            <b>Every existing link stops working.</b> Anyone who bookmarked it, or was sent it,
            gets a 404 with no hint of where it went. There is no redirect and no undo.
          </span>
        </div>

        <ul className="plain-list">
          <li>The files are copied to the new address first, then removed from the old one — nothing is lost.</li>
          <li>Any passkey stays the same. Rotate that separately if the key is what leaked.</li>
          <li>Your analytics carry over; they follow the page, not the address.</li>
        </ul>

        <label>
          Type <code>{page.pageId}</code> to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck="false"
            placeholder={page.pageId} />
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="danger" disabled={busy || !ready}>
            {busy ? 'Moving files…' : 'Issue a New Address'}
          </button>
        </div>
      </form>
    </div>
  );
}
