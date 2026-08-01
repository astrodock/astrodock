import { useState } from 'react';
import Modal from './Modal';

// Choosing what to roll back to.
//
// This was a window.confirm() reading "roll back to the last successful build".
// That is the right default and the wrong only-option: a deploy can succeed and
// still be wrong — code that builds, starts, passes a health check and does the
// incorrect thing — and in that case the last success is exactly what you do not
// want. So: pick the build.

function when(d) {
  const t = d.finishedAt || d.startedAt || d.createdAt;
  return t ? new Date(t).toLocaleString() : 'unknown';
}

export default function RollbackModal({ deployments, current, onClose, onRollback }) {
  // Only successful builds from a repo can be re-deployed; a local push has no
  // commit to go back to.
  const candidates = deployments
    .filter((d) => d.status === 'success' && d.commitHash && d.commitHash !== 'local')
    .slice(0, 15);

  const [picked, setPicked] = useState(candidates.find((d) => d.commitHash !== current)?.commitHash || '');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Roll Back"
      subtitle="Re-deploys an earlier build. Nothing is deleted — this is another deploy, of older code."
      onClose={busy ? undefined : onClose}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !picked}
            onClick={async () => { setBusy(true); try { await onRollback(picked); } finally { setBusy(false); } }}>
            {busy ? 'Starting…' : 'Roll Back to This'}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="hint">
          There is no earlier successful build from a connected repository to go back to.
        </p>
      ) : (
        <>
          <p className="hint" style={{ marginTop: '-.4rem', marginBottom: 12 }}>
            Your variables and data are untouched — only the code changes.
          </p>
          <div className="opt-list">
            {candidates.map((d) => {
              const isCurrent = d.commitHash === current;
              return (
                <label className={`opt-row ${picked === d.commitHash ? 'on' : ''}`} key={d.id}
                  style={{ cursor: isCurrent ? 'not-allowed' : 'pointer', opacity: isCurrent ? 0.5 : 1 }}>
                  <span className="name">
                    <b>
                      <code>{d.commitHash}</code>
                      {isCurrent && <span className="tag" style={{ marginLeft: 8 }}>running now</span>}
                    </b>
                    <span className="opt-desc">
                      {d.commitMessage || 'No commit message'} · {when(d)}
                    </span>
                  </span>
                  <input
                    type="radio"
                    name="rollback-target"
                    checked={picked === d.commitHash}
                    disabled={isCurrent}
                    onChange={() => setPicked(d.commitHash)}
                    style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                  />
                </label>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
