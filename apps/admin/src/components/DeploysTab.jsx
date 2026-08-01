import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import RollbackModal from './RollbackModal';
import Modal from './Modal';

const STATUS = {
  pending: { led: 'run', label: 'Queued' },
  cloning: { led: 'run', label: 'Cloning' },
  building: { led: 'run', label: 'Building' },
  deploying: { led: 'run', label: 'Deploying' },
  success: { led: 'ok', label: 'Live' },
  failed: { led: 'crit', label: 'Failed' }
};
const TRIGGER = { webhook: 'GitHub push', manual: 'manual', cli: 'CLI · agent', rollback: 'rollback', local: 'local upload' };

const IN_PROGRESS = ['pending', 'cloning', 'building', 'deploying'];

export default function DeploysTab({ app, missingRequired = [], onRefresh }) {
  const [deployments, setDeployments] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedLog, setExpandedLog] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState(missingRequired);
  const [showRollback, setShowRollback] = useState(false);
  const [showNoRepo, setShowNoRepo] = useState(false);
  const intervalRef = useRef(null);
  const expandedIdRef = useRef(null);
  const logRef = useRef(null);

  // Keep refs / props in sync with state
  useEffect(() => { expandedIdRef.current = expandedId; }, [expandedId]);
  useEffect(() => { setMissing(missingRequired); }, [missingRequired]);

  async function loadDeployments() {
    try {
      const data = await api.getDeployments(app.slug);
      setDeployments(data.deployments);
      return data.deployments;
    } catch (err) {
      setError(err.message);
      return [];
    }
  }

  const refreshExpandedLog = useCallback(async () => {
    const id = expandedIdRef.current;
    if (!id) return;
    try {
      const data = await api.getDeployment(app.slug, id);
      setExpandedLog(data.deployment.log || 'Waiting for output...');
    } catch {}
  }, [app.slug]);

  useEffect(() => { loadDeployments(); }, [app.slug]);

  function startPolling() {
    stopPolling();
    intervalRef.current = setInterval(async () => {
      const deps = await loadDeployments();
      await refreshExpandedLog();

      const hasActive = deps.some(d => IN_PROGRESS.includes(d.status));
      if (!hasActive) {
        stopPolling();
        await refreshExpandedLog();
      }
    }, 2000);
  }

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  useEffect(() => () => stopPolling(), []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [expandedLog]);

  async function handleDeploy() {
    if (!app.repoConnected) {
      setShowNoRepo(true);
      return;
    }
    if (!app.provisioned) {
      setError('App must be provisioned first (Settings tab)');
      return;
    }
    setDeploying(true);
    setError('');
    try {
      const result = await api.triggerDeploy(app.slug);
      setMissing([]);
      // Wait for the deployment record to be created
      setTimeout(async () => {
        const deps = await loadDeployments();
        setDeploying(false);
        const active = deps.find(d => IN_PROGRESS.includes(d.status)) || deps[0];
        const targetId = result?.deploymentId || active?.id;
        if (targetId) {
          setExpandedId(targetId);
          expandedIdRef.current = targetId;
          setExpandedLog('Starting deploy...');
          startPolling();
        }
      }, 1500);
    } catch (err) {
      setDeploying(false);
      // 422: deploy blocked by missing required env vars
      if (err.status === 422 && Array.isArray(err.body?.missing)) {
        setMissing(err.body.missing);
        setError('Deploy blocked — set the required environment variables below (Env tab).');
      } else {
        setError(err.message);
      }
    }
  }

  async function doRollback(targetCommit) {
    setDeploying(true);
    setError('');
    try {
      setShowRollback(false);
      const result = await api.rollbackApp(app.slug, targetCommit);
      setTimeout(async () => {
        const deps = await loadDeployments();
        setDeploying(false);
        const targetId = result?.deploymentId || deps.find(d => IN_PROGRESS.includes(d.status))?.id;
        if (targetId) {
          setExpandedId(targetId);
          expandedIdRef.current = targetId;
          setExpandedLog('Starting rollback...');
          startPolling();
        }
      }, 1500);
    } catch (err) {
      setDeploying(false);
      setError(err.message);
    }
  }

  async function handleExpand(id) {
    if (expandedId === id) {
      setExpandedId(null);
      expandedIdRef.current = null;
      stopPolling();
      return;
    }
    try {
      const data = await api.getDeployment(app.slug, id);
      setExpandedLog(data.deployment.log || 'No log output');
      setExpandedId(id);
      expandedIdRef.current = id;

      if (IN_PROGRESS.includes(data.deployment.status)) {
        startPolling();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(start, end) {
    if (!start || !end) return '';
    const ms = new Date(end) - new Date(start);
    const secs = Math.round(ms / 1000);
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  return (
    <div>
      <div className="tab-header">
        <h2>Deploys</h2>
        <div className="modal-actions" style={{ margin: 0 }}>
          {deployments.some(d => d.status === 'success') && (
            <button className="secondary" onClick={() => setShowRollback(true)} disabled={deploying}>Roll Back</button>
          )}
          <button onClick={handleDeploy} disabled={deploying}>
            {deploying ? 'Deploying...' : 'Deploy now'}
          </button>
        </div>
      </div>
      <p className="hint">
        A deploy pulls your latest code, builds it, and puts it live. Pushing to your connected
        branch deploys automatically; or click <b>Deploy now</b>. A failed deploy is not undone
        for you — what is already live keeps running, and you decide whether to fix forward or
        use <b>Roll Back</b> to put an earlier build back.
      </p>

      {error && <div className="error">{error}</div>}

      {missing.length > 0 && (
        <div className="missing-vars-banner">
          <strong>Deploy blocked: {missing.length} required variable{missing.length > 1 ? 's' : ''} not set</strong>
          <ul>
            {missing.map(m => (
              <li key={m.key}>
                <code>{m.key}</code>
                {m.reason && <span className="missing-reason"> — {m.reason}</span>}
              </li>
            ))}
          </ul>
          <p className="hint">Set these in the Env tab, then deploy again.</p>
        </div>
      )}

      {deployments.length === 0 ? (
        <EmptyState icon="deploy" title="No Deploys Yet"
          body="Connect a repository under Settings, then deploy — each build and its result is kept here." />
      ) : (
        <div className="dep-list">
          {deployments.map((d, i) => {
            const isActive = IN_PROGRESS.includes(d.status);
            const isCurrentFailure = i === 0 && d.status === 'failed';
            const st = STATUS[d.status] || { led: '', label: d.status };
            const expanded = expandedId === d.id;
            return (
              <div key={d.id} className={`dep-item ${isActive ? 'active' : ''} ${d.status === 'failed' ? 'failed' : ''}`}>
                <div className="dep-row" onClick={() => handleExpand(d.id)}>
                  <span className="dep-st">{isActive ? <span className="runspin" /> : <span className={`led ${st.led} ${isCurrentFailure ? 'pulse' : ''}`} />}<b>{st.label}</b></span>
                  <span className="dep-commit">
                    <code className={d.commitHash ? '' : 'muted'}>{d.commitHash || '—'}</code>
                    {d.commitMessage && <span className="dep-msg">{d.commitMessage}</span>}
                  </span>
                  <span className="dep-trigger">{TRIGGER[d.trigger] || d.trigger}</span>
                  <span className="dep-time">{formatTime(d.startedAt || d.createdAt)}{d.finishedAt && ` · ${formatDuration(d.startedAt || d.createdAt, d.finishedAt)}`}</span>
                  <svg className={`dep-chev ${expanded ? 'open' : ''}`} width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
                {expanded && (
                  <div className="dep-detail">
                    <pre className="deploy-log" ref={logRef}>{expandedLog}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showRollback && (
        <RollbackModal
          deployments={deployments}
          current={deployments.find((d) => d.status === 'success')?.commitHash}
          onClose={() => setShowRollback(false)}
          onRollback={doRollback}
        />
      )}

      {showNoRepo && (
        <Modal
          title="No Repository Connected"
          subtitle="Deploy now builds from a Git repository, and this app doesn't have one yet."
          onClose={() => setShowNoRepo(false)}
          footer={<button type="button" className="primary" onClick={() => setShowNoRepo(false)}>Got It</button>}
        >
          <p>
            This app's code was uploaded directly rather than pulled from a repository, so there
            is nothing here for Astrodock to fetch and rebuild.
          </p>
          <p>You have two ways forward:</p>
          <ul className="plain-list">
            <li>
              <b>Push again the same way</b> — using the CLI (<code>astrodock deploy</code>) or
              whatever you used the first time. Nothing to set up.
            </li>
            <li>
              <b>Connect a repository</b> under <b>Settings</b>. After that, every push to your
              chosen branch deploys on its own, and <b>Deploy now</b> and <b>Roll Back</b> start
              working here.
            </li>
          </ul>
        </Modal>
      )}
    </div>
  );
}
