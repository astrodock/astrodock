import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../lib/api';

const STATUS_COLORS = {
  pending: 'var(--text-muted)',
  cloning: 'var(--info)',
  building: 'var(--info)',
  deploying: 'var(--info)',
  success: 'var(--accent)',
  failed: 'var(--danger)'
};

const IN_PROGRESS = ['pending', 'cloning', 'building', 'deploying'];

export default function DeploysTab({ app, onRefresh }) {
  const [deployments, setDeployments] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedLog, setExpandedLog] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const intervalRef = useRef(null);
  const expandedIdRef = useRef(null);
  const logRef = useRef(null);

  // Keep ref in sync with state
  useEffect(() => { expandedIdRef.current = expandedId; }, [expandedId]);

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
    if (!app.githubRepo) {
      setError('Connect a GitHub repo first (Settings tab)');
      return;
    }
    if (!app.isProvisioned) {
      setError('App must be provisioned first');
      return;
    }
    setDeploying(true);
    setError('');
    try {
      await api.triggerDeploy(app.slug);
      // Wait for the deployment record to be created
      setTimeout(async () => {
        const deps = await loadDeployments();
        setDeploying(false);
        if (deps.length > 0 && IN_PROGRESS.includes(deps[0].status)) {
          // Set the expanded ID BEFORE starting polling
          setExpandedId(deps[0]._id);
          expandedIdRef.current = deps[0]._id;
          setExpandedLog('Starting deploy...');
          startPolling();
        }
      }, 1500);
    } catch (err) {
      setError(err.message);
      setDeploying(false);
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
        <h2>Deployments</h2>
        <button onClick={handleDeploy} disabled={deploying}>
          {deploying ? 'Deploying...' : 'Deploy Now'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {deployments.length === 0 ? (
        <p className="empty-state">No deployments yet. Connect a repo and click Deploy Now.</p>
      ) : (
        <div className="deploy-list">
          {deployments.map(d => {
            const isActive = IN_PROGRESS.includes(d.status);
            return (
              <div key={d._id} className={`deploy-item ${isActive ? 'deploy-active' : ''}`}>
                <div className="deploy-row" onClick={() => handleExpand(d._id)}>
                  <span className="deploy-status" style={{ color: STATUS_COLORS[d.status] }}>
                    {isActive && <span className="deploy-spinner" />}
                    {d.status}
                  </span>
                  <span className="deploy-commit">
                    {d.commitHash && <code>{d.commitHash}</code>}
                    {d.commitMessage && <span className="deploy-msg">{d.commitMessage}</span>}
                  </span>
                  <span className="deploy-meta">
                    <span className="deploy-trigger">{d.trigger}</span>
                    <span>{formatTime(d.startedAt)}</span>
                    {d.finishedAt && (
                      <span className="deploy-duration">
                        {formatDuration(d.startedAt, d.finishedAt)}
                      </span>
                    )}
                  </span>
                </div>
                {expandedId === d._id && (
                  <pre className="deploy-log" ref={logRef}>{expandedLog}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
