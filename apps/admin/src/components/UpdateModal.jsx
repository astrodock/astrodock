import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';

// Applying an update, from the dashboard that is about to be replaced by it.
//
// The awkward part is the middle: once the stack is recreated, the api serving
// this page stops answering and the browser is talking to nothing for a minute
// or so. That is not a failure and must not look like one — so the progress here
// treats "the dashboard went away" as an expected stage, and keeps polling until
// it comes back and reports its version.

const STAGES = [
  ['backup', 'Backing up the database', 'So there is a way back if the new version cannot read the old data.'],
  ['pull', 'Downloading the new version', 'Nothing has changed yet — the running platform is untouched.'],
  ['restart', 'Restarting the platform', 'The dashboard stops responding here. That is expected.'],
  ['verify', 'Checking it came back', 'If it does not, Astrodock puts the previous version back by itself.']
];

export default function UpdateModal({ current, latest, onClose, onDone }) {
  const [phase, setPhase] = useState('confirm');   // confirm | running | done | failed
  const [error, setError] = useState('');
  const [stage, setStage] = useState(0);
  const [result, setResult] = useState(null);
  const startedAt = useRef(null);
  const poll = useRef(null);

  useEffect(() => () => clearInterval(poll.current), []);

  async function start() {
    setPhase('running'); setError(''); setStage(0);
    startedAt.current = Date.now();
    try {
      await api.applyUpdate(latest || null);
    } catch (err) {
      if (err.body?.code === 'reauth_required') { onClose(); onDone(null, err); return; }
      setError(err.message); setPhase('failed'); return;
    }

    // Two things are watched, because success and failure arrive by different
    // routes. Success shows up as /health reporting a new version — the api that
    // would have replied to the request is gone by then. Failure shows up as an
    // event the updater wrote before exiting, and the api may never have gone
    // down at all: a refused pull is over in two seconds.
    //
    // Watching only /health meant failures ran to a five-minute timeout while the
    // reason sat in the database the whole time.
    setStage(1);
    poll.current = setInterval(async () => {
      const elapsed = Date.now() - startedAt.current;
      if (elapsed > 12000) setStage((s) => (s < 2 ? 2 : s));

      // Did the updater record an outcome?
      try {
        const st = await api.updateStatus();
        const latest = st?.latest;
        if (latest && new Date(latest.at).getTime() >= startedAt.current - 5000) {
          if (latest.type === 'update.failed' || latest.type === 'update.rolled_back') {
            clearInterval(poll.current);
            setResult({ meta: latest.meta, type: latest.type });
            setError(latest.message);
            setPhase('failed');
            return;
          }
          if (latest.type === 'update.succeeded') {
            clearInterval(poll.current);
            setStage(3);
            setResult({ version: latest.meta?.to || st.version });
            setPhase('done');
            return;
          }
        }
      } catch { /* the api is being replaced — expected mid-restart */ }

      // Or has it simply come back as something new?
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json();
          const now = String(body.version || '').replace(/^v/, '');
          const was = String(current || '').replace(/^v/, '');
          if (now && now !== was) {
            clearInterval(poll.current);
            setStage(3); setResult({ version: now }); setPhase('done');
            return;
          }
        }
      } catch { /* still down — expected */ }

      if (elapsed > 5 * 60 * 1000) {
        clearInterval(poll.current);
        setPhase('failed');
        setError('The platform has not come back after five minutes, and the updater recorded nothing. Check Activity, and the containers on the server.');
      }
    }, 2000);
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => phase !== 'running' && e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {phase === 'confirm' && (
          <>
            <h2>Update Astrodock</h2>
            <p className="hint" style={{ marginTop: '-.9rem' }}>
              {current} → <b>{latest}</b>
            </p>

            <ul className="plain-list">
              <li>A database backup is taken first, automatically.</li>
              <li>Your apps keep running — this replaces the platform, not the things it hosts.</li>
              <li>The dashboard goes away for a minute or so while the platform restarts.</li>
              <li>If the new version does not come back up, Astrodock puts the previous one back without being asked.</li>
            </ul>

            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" onClick={start}>Update Now</button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <h2>Updating</h2>
            <p className="hint" style={{ marginTop: '-.9rem' }}>
              Leave this page open. It reconnects by itself.
            </p>
            <ol className="stages">
              {STAGES.map(([key, label, why], i) => (
                <li key={key} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
                  <span className="dot" />
                  <div>
                    <b>{label}</b>
                    <span>{why}</span>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2>Updated</h2>
            <div className="rcard ok" style={{ marginBottom: 14 }}>
              <span className="led ok" />
              <span>Astrodock is now on <b>{result?.version}</b>.</span>
            </div>
            <p className="hint">Reload to pick up the new dashboard.</p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
            </div>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h2>{result?.type === 'update.rolled_back' ? 'Rolled Back' : 'Update Did Not Finish'}</h2>
            <div className="error">{error}</div>
            {result?.meta?.stage === 'pull' && (
              <div className="rcard ok" style={{ marginBottom: 12 }}>
                <span className="led ok" />
                <span>
                  <b>Nothing was changed.</b> It stopped before touching the running platform, so
                  you are still on the version you started on.
                </span>
              </div>
            )}
            <p className="hint">
              {result?.meta?.backup
                ? <>A backup was taken first — <code>{result.meta.backup}</code>, listed under Settings → Backups. </>
                : <>A backup is taken before anything changes; see Settings → Backups. </>}
              You can also update from the server with
              <code> docker compose pull &amp;&amp; docker compose up -d</code>.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Close</button>
              <button type="button" onClick={() => window.location.reload()}>Reload</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
