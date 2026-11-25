import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import { SkeletonRows } from '../components/Loading';
import Select from '../components/Select';
import useConfirm from '../lib/useConfirm';

// Artifacts: small apps an AI agent builds, each with its own data and its own
// address, shared by email. Folders on the left; the list on the right.

const STARTER = (title) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, '')}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#222}</style>
</head>
<body>
<h1>${title.replace(/[<&]/g, '')}</h1>
<p>This artifact has no content yet. Upload files, or ask your AI agent to build it.</p>
<script src="/_astrodock/client.js"></script>
</body>
</html>
`;

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function when(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ArtifactsPage() {
  const navigate = useNavigate();
  const [confirmNode, ask] = useConfirm();
  const [artifacts, setArtifacts] = useState([]);
  const [folders, setFolders] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState('all'); // all | shared | feedback | <folder id>
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(null); // { title, folderId }
  const [folderDraft, setFolderDraft] = useState(null); // { id?, name }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [everyone, setEveryone] = useState(null);
  const [queue, setQueue] = useState(null);

  async function load() {
    try {
      const [a, f] = await Promise.all([api.getArtifacts(), api.getArtifactFolders()]);
      setArtifacts(a.artifacts || []);
      setFolders(f.folders || []);
    } catch (err) { setError(err.message); }
    setLoaded(true);
  }
  useEffect(() => {
    load();
    // Owners and admins hold artifacts:admin: everyone's artifacts and the report queue.
    api.getAccount().then((a) => setIsAdmin(['owner', 'admin'].includes((a.user || a).role))).catch(() => {});
  }, []);
  async function loadEveryone() {
    try { setEveryone((await api.getArtifactsUsage(true)).artifacts); } catch (err) { setError(err.message); }
  }
  async function loadQueue() {
    try { setQueue((await api.getArtifactReportQueue('open')).reports); } catch (err) { setError(err.message); }
  }
  useEffect(() => {
    if (view === 'everyone') loadEveryone();
    if (view === 'queue') loadQueue();
  }, [view]);
  async function setSuspended(a, suspended) {
    try { await api.updateArtifact(a.id, suspended ? { suspended: true, suspendedReason: 'Taken down by an admin' } : { suspended: false }); await loadEveryone(); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => {
    if (view === 'feedback') api.getArtifactFeedback().then((r) => setFeedback(r.feedback || [])).catch((err) => setError(err.message));
  }, [view]);

  const folder = folders.find((f) => f.id === view);
  const shown = artifacts.filter((a) => {
    if (view === 'all') return a.access === 'owner';
    if (view === 'shared') return a.access !== 'owner';
    return a.folderId === view && a.access === 'owner';
  });

  async function create(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const title = creating.title.trim() || 'Untitled';
      const { artifact } = await api.createArtifact({ title, folderId: creating.folderId || undefined, content: STARTER(title) });
      setCreating(null);
      navigate(`/artifacts/${artifact.id}`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function saveFolder(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (folderDraft.id) await api.renameArtifactFolder(folderDraft.id, folderDraft.name);
      else {
        const { folder: f } = await api.createArtifactFolder(folderDraft.name);
        setView(f.id);
      }
      setFolderDraft(null);
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  function copyLink(e, a) {
    e.stopPropagation();
    navigator.clipboard?.writeText(a.url).then(() => { setCopied(a.id); setTimeout(() => setCopied(''), 1500); });
  }

  const navItem = (key, label, count) => (
    <li key={key}>
      <button type="button" className={`folder-link${view === key ? ' active' : ''}`} onClick={() => setView(key)}>
        <span>{label}</span>{count !== undefined && <span className="folder-count">{count}</span>}
      </button>
    </li>
  );

  return (
    <>
      {confirmNode}
      <div>
        <PageHeader
          title="Artifacts"
          description="Small apps your AI agent builds, each with its own data and address. Share them by email; people sign in with a code."
          action={<div className="btn-row">
            <button onClick={() => setFolderDraft({ name: '' })}>New Folder</button>
            <button className="primary" onClick={() => setCreating({ title: '', folderId: folder ? folder.id : '' })}>New Artifact</button>
          </div>}
        />

        {error && <div className="error">{error}</div>}

        <div className="folder-layout">
          <nav className="folder-nav" aria-label="Folders">
            <ul>
              {navItem('all', 'All Artifacts', artifacts.filter((a) => a.access === 'owner').length)}
              {navItem('shared', 'Shared With Me', artifacts.filter((a) => a.access !== 'owner').length)}
            </ul>
            {folders.length > 0 && <>
              <h3>Folders</h3>
              <ul>{folders.map((f) => navItem(f.id, f.name, artifacts.filter((a) => a.folderId === f.id && a.access === 'owner').length))}</ul>
            </>}
            <ul className="folder-nav-end">{navItem('feedback', 'Capability Feedback')}</ul>
            {isAdmin && <>
              <h3>Admin</h3>
              <ul>{navItem('everyone', 'Everyone\'s Artifacts')}{navItem('queue', 'Harm Reports')}</ul>
            </>}
          </nav>

          <section className="folder-main">
            {folder && (
              <div className="tab-header">
                <h2>{folder.name}</h2>
                <div className="btn-row">
                  <button onClick={() => setFolderDraft({ id: folder.id, name: folder.name })}>Rename</button>
                  <button className="danger" onClick={() => ask({
                    title: 'Delete This Folder?',
                    danger: true,
                    confirmLabel: 'Delete Folder',
                    body: <p>The folder is removed. The artifacts in it are kept and move to All Artifacts.</p>,
                    onConfirm: async () => { await api.deleteArtifactFolder(folder.id); setView('all'); await load(); }
                  })}>Delete</button>
                </div>
              </div>
            )}

            {view === 'everyone' ? (
              !everyone ? <SkeletonRows rows={3} cols={6} /> : everyone.length === 0
                ? <EmptyState icon="pages" title="No Artifacts" body="Nobody on this platform has made an artifact yet." />
                : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead><tr><th>Artifact</th><th>Owner</th><th>Views</th><th>People</th><th>Records</th><th>Storage</th><th>Emails</th><th>Errors</th><th>Reports</th><th>Last Activity</th><th></th></tr></thead>
                      <tbody>
                        {everyone.map((a) => (
                          <tr key={a.id} className={a.suspended ? 'inactive' : ''}>
                            <td><a href={a.url} target="_blank" rel="noopener"><strong>{a.title || 'Untitled'}</strong></a><span className="row-subtitle">{a.id}{a.visibility === 'public' ? ' · Public' : ''}{a.suspended ? ' · Taken Down' : ''}</span></td>
                            <td>{a.owner || 'No Owner'}</td>
                            <td>{a.usage.views30}</td>
                            <td>{a.usage.people30}</td>
                            <td>{a.usage.records}</td>
                            <td>{fmtBytes(a.usage.storageBytes)}</td>
                            <td>{a.usage.emails30}</td>
                            <td>{a.usage.errors7}</td>
                            <td>{a.usage.openReports}</td>
                            <td>{a.usage.lastActivity ? when(a.usage.lastActivity) : 'None'}</td>
                            <td className="row-actions">
                              <button className="link-btn" onClick={() => navigate(`/artifacts/${a.id}`)}>Details</button>
                              {a.suspended
                                ? <button className="link-btn" onClick={() => setSuspended(a, false)}>Restore</button>
                                : <button className="link-btn danger" onClick={() => ask({
                                  title: `Take Down ${a.title || 'This Artifact'}?`, danger: true, confirmLabel: 'Take Down',
                                  body: <p>Its address shows that it was taken down. The owner keeps the files and data, and you can restore it.</p>,
                                  onConfirm: () => setSuspended(a, true)
                                })}>Take Down</button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="hint">Views, people, emails: last 30 days. Errors: last 7 days. Reports: open.</p>
                  </div>
                )
            ) : view === 'queue' ? (
              !queue ? <SkeletonRows rows={3} cols={4} /> : queue.length === 0
                ? <EmptyState icon="pages" title="No Open Reports" body="Reports that an artifact is harmful or abusive show up here." />
                : (
                  <table className="data-table">
                    <thead><tr><th>Report</th><th>Artifact</th><th>From</th><th>When</th><th></th></tr></thead>
                    <tbody>
                      {queue.map((r) => (
                        <tr key={r.id}>
                          <td>{r.message}</td>
                          <td><a href={`/artifacts/${r.artifact.id}`} onClick={(e) => { e.preventDefault(); navigate(`/artifacts/${r.artifact.id}`); }}>{r.artifact.title || r.artifact.id}</a></td>
                          <td>{r.email || 'Not Signed In'}</td>
                          <td>{when(r.createdAt)}</td>
                          <td className="row-actions">
                            <button className="link-btn" onClick={async () => { try { await api.setArtifactReport(r.id, 'closed'); await loadQueue(); } catch (err) { setError(err.message); } }}>Close</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            ) : view === 'feedback' ? (
              <>
                <p className="hint">What agents building artifacts needed and could not do. Each item is also sent to the Astrodock project.</p>
                {feedback.length === 0 ? (
                  <EmptyState icon="pages" title="No Feedback Yet" body="Agents add an item here when an artifact needs something this setup cannot do." />
                ) : (
                  <table className="data-table">
                    <thead><tr><th>Needed</th><th>Tried</th><th>Workaround</th><th>From</th><th>Sent</th><th>Date</th></tr></thead>
                    <tbody>
                      {feedback.map((f) => (
                        <tr key={f.id}>
                          <td>{f.needed}</td>
                          <td className="text-muted">{f.tried}</td>
                          <td className="text-muted">{f.workaround}</td>
                          <td>{f.source === 'upstream' ? 'Another Instance' : (f.actor || 'This Instance')}</td>
                          <td>{f.source === 'upstream' ? 'Received' : ({ sent: 'Sent', failed: 'Failed', pending: 'Pending', none: 'Not Sent' }[f.upstreamStatus] || f.upstreamStatus)}</td>
                          <td>{when(f.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ) : !loaded ? <SkeletonRows rows={3} cols={4} /> : shown.length === 0 ? (
              view === 'shared'
                ? <EmptyState icon="pages" title="Nothing Shared With You" body="Artifacts other people share with your email address show up here." />
                : <EmptyState icon="pages" title="No Artifacts Yet"
                  body="Create one here, or ask your AI agent to build one. Agents read the guide at /admin/artifacts/guide."
                  action={<button className="primary" onClick={() => setCreating({ title: '', folderId: folder ? folder.id : '' })}>New Artifact</button>} />
            ) : (
              <table className="data-table clickable">
                <thead>
                  <tr><th>Title</th><th>Link</th><th>{view === 'shared' ? 'Your Role' : 'Visibility'}</th><th>Updated</th></tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr key={a.id} className={a.isActive && !a.suspended ? '' : 'inactive'}
                      onClick={() => (a.access === 'owner' ? navigate(`/artifacts/${a.id}`) : window.open(a.url, '_blank', 'noopener'))}>
                      <td><strong>{a.title || 'Untitled'}</strong><span className="row-subtitle">{a.id}{a.suspended ? ' · Taken Down' : !a.isActive ? ' · Turned Off' : ''}</span></td>
                      <td>
                        <a href={a.url} className="app-link" target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>Open</a>
                        <button className="link-btn" style={{ marginLeft: 8 }} onClick={(e) => copyLink(e, a)}>{copied === a.id ? 'Copied' : 'Copy'}</button>
                      </td>
                      <td>{view === 'shared' ? a.access : (a.visibility === 'public' ? 'Public' : 'Shared by Email')}</td>
                      <td>{when(a.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {creating && (
          <div className="modal-overlay" onClick={() => setCreating(null)}>
            <form className="modal" onClick={(e) => e.stopPropagation()} noValidate onSubmit={create}>
              <h2>New Artifact</h2>
              {error && <div className="error">{error}</div>}
              <label>
                Title
                <input value={creating.title} onChange={(e) => setCreating({ ...creating, title: e.target.value })} placeholder="Team Tasks" autoFocus />
              </label>
              {folders.length > 0 && (
                <label>
                  Folder
                  <Select value={creating.folderId} onChange={(v) => setCreating({ ...creating, folderId: v })}
                    options={[{ value: '', label: 'No Folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />
                </label>
              )}
              <p className="hint">It starts with a placeholder page, private to you. Add files and share it on the next screen.</p>
              <div className="modal-actions">
                <button type="button" onClick={() => setCreating(null)}>Cancel</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
              </div>
            </form>
          </div>
        )}

        {folderDraft && (
          <div className="modal-overlay" onClick={() => setFolderDraft(null)}>
            <form className="modal" onClick={(e) => e.stopPropagation()} noValidate onSubmit={saveFolder}>
              <h2>{folderDraft.id ? 'Rename Folder' : 'New Folder'}</h2>
              {error && <div className="error">{error}</div>}
              <label>
                Name
                <input value={folderDraft.name} onChange={(e) => setFolderDraft({ ...folderDraft, name: e.target.value })} placeholder="Operations" autoFocus />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setFolderDraft(null)}>Cancel</button>
                <button type="submit" className="primary" disabled={busy || !folderDraft.name.trim()}>{folderDraft.id ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </>
  );
}
