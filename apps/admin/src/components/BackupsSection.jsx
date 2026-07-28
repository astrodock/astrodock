import { useState, useRef } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import ReauthModal from './ReauthModal';

// Backups: take one, carry one off the box, bring one back, put one back in place.
//
// The list used to say "download / restore soon", which made the whole feature
// decorative — a backup you cannot retrieve or replay is a file you are paying
// disk for. All four now work.
//
// Restore is deliberately awkward. It replaces everything, it cannot be undone
// by clicking again, and the dashboard goes away mid-operation while the api
// restarts. So: type the date to confirm, and read what is about to happen.

function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

const TRIGGER_LABEL = {
  scheduled: 'On schedule', manual: 'By hand', uploaded: 'Uploaded', 'pre-restore': 'Before a restore'
};

function RestoreModal({ backup, onClose, onDone }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const when = new Date(backup.createdAt);
  // Something specific to this backup, so muscle memory cannot carry you through.
  const phrase = when.toISOString().slice(0, 10);

  async function go() {
    setBusy(true); setError('');
    try { onDone(await api.restoreBackup(backup.id)); }
    catch (err) {
      if (err.body?.code === 'reauth_required') { onClose(); onDone(null, err); return; }
      setError(err.message); setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Restore This Backup</h2>

        <div className="rcard crit" style={{ marginBottom: 14 }}>
          <span className="led crit" />
          <span>
            <b>Everything in the database is replaced</b> with the contents of this file, as it stood
            on {when.toLocaleString()}. Apps, users, access keys, settings and history all revert.
            Anything created since is gone.
          </span>
        </div>

        <ul className="plain-list">
          <li>A fresh backup of the current database is taken first, automatically — if this turns out
            to be the wrong file, you can come back from it.</li>
          <li>Live connections are dropped and the dashboard stops responding for a minute or so while
            the platform restarts. That is expected, not a failure.</li>
          <li>Files in object storage are <b>not</b> part of this backup and are left untouched.</li>
        </ul>

        {error && <div className="error">{error}</div>}

        <label>
          Type <code>{phrase}</code> to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
            placeholder={phrase} spellCheck="false" />
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="danger" disabled={busy || typed.trim() !== phrase} onClick={go}>
            {busy ? 'Restoring…' : 'Replace the database'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackupsSection({ backups, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [restoring, setRestoring] = useState(null);
  const [reauth, setReauth] = useState(null);
  const [restored, setRestored] = useState(null);
  const fileInput = useRef(null);

  if (!backups) return null;
  const rows = backups.backups || [];

  // Same shape as AccountPage: if the server wants a fresh factor, say which
  // action is being confirmed and retry it, rather than losing the operator's place.
  async function guarded(fn, action) {
    setError(''); setNote('');
    try { await fn(); }
    catch (err) {
      if (err.body?.code === 'reauth_required') setReauth({ action, retry: () => guarded(fn, action) });
      else setError(err.message);
    }
  }

  async function takeBackup() {
    setBusy('run'); setError(''); setNote('');
    try { await api.runBackup(); setNote('Backup complete.'); onChanged?.(); }
    catch (err) { setError(`Backup failed: ${err.message}`); } finally { setBusy(''); }
  }

  function download(b) {
    guarded(async () => {
      setBusy(b.id);
      try { const name = await api.downloadBackup(b.id); setNote(`Downloaded ${name}.`); }
      finally { setBusy(''); }
    }, 'Downloading a backup');
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload'); setError(''); setNote('');
    try {
      await api.uploadBackup(file);
      setNote(`${file.name} added to the list. It is not restored until you say so.`);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }

  return (
    <section className="set-section">
      <div className="sec-head">
        <div>
          <h2>Backups</h2>
          <p>
            A copy of your database is saved {backups.config.intervalHours > 0
              ? `every ${backups.config.intervalHours} hours` : '— on a schedule that is currently off'},
            keeping the last {backups.config.keep}, in <code>{backups.config.dir}</code> on this server.
            Files in object storage are not included.
          </p>
        </div>
        <div className="sec-actions">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy === 'upload'}>
            {busy === 'upload' ? 'Uploading…' : 'Upload'}
          </button>
          <button type="button" className="primary" onClick={takeBackup} disabled={busy === 'run'}>
            {busy === 'run' ? 'Backing up…' : 'Back Up Now'}
          </button>
        </div>
      </div>

      <input ref={fileInput} type="file" accept=".gz,application/gzip" onChange={upload} hidden />

      {error && <div className="error">{error}</div>}
      {note && <div className="rcard ok" style={{ marginBottom: 12 }}><span className="led ok" /><span>{note}</span></div>}

      {restored && (
        <div className="rcard warn" style={{ marginBottom: 12 }}>
          <span className="led warn" />
          <span>
            <b>Restored from {restored.restoredFrom}.</b> The platform is restarting — reload in a
            moment. The database as it was a minute ago was saved to <code>{restored.safetyBackup}</code>.
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon="file" title="No Backups Yet"
          body="Backups appear here once one has run. You can also upload a dump taken from another Astrodock instance."
          action={<button type="button" className="primary" onClick={takeBackup}>Back Up Now</button>} />
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>When</th><th>Result</th><th>Size</th><th>How</th><th /></tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((b) => (
              <tr key={b.id}>
                <td>{new Date(b.createdAt).toLocaleString()}</td>
                <td>
                  <span className={`led ${b.status === 'success' ? 'ok' : 'crit'}`} style={{ marginRight: 8 }} />
                  {b.status === 'success' ? 'Saved' : 'Failed'}
                  {b.error && <span className="hint"> — {b.error.slice(0, 60)}</span>}
                </td>
                <td>{fmtBytes(b.sizeBytes)}</td>
                <td>{TRIGGER_LABEL[b.trigger] || b.trigger}</td>
                <td className="actions">
                  {b.status === 'success' && (
                    <>
                      <button type="button" onClick={() => download(b)} disabled={busy === b.id}>
                        {busy === b.id ? 'Preparing…' : 'Download'}
                      </button>
                      <button type="button" className="danger" onClick={() => setRestoring(b)}>Restore</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {restoring && (
        <RestoreModal
          backup={restoring}
          onClose={() => setRestoring(null)}
          onDone={(result, err) => {
            setRestoring(null);
            if (err) { setReauth({ action: 'Restoring a backup', retry: () => setRestoring(restoring) }); return; }
            setRestored(result); onChanged?.();
          }}
        />
      )}

      {reauth && (
        <ReauthModal
          action={reauth.action}
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}
    </section>
  );
}
