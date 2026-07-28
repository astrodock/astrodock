import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';

export default function LogsTab({ app }) {
  const [view, setView] = useState('runtime'); // runtime | access
  const [logs, setLogs] = useState('');
  const [access, setAccess] = useState(null);
  const [lines, setLines] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);

  async function load() {
    setError('');
    try {
      if (view === 'runtime') {
        const data = await api.getAppLogs(app.slug, lines);
        setLogs(data.logs);
      } else {
        setAccess(await api.getAppAccessLogs(app.slug));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [app.slug, lines, view]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, app.slug, lines, view]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div>
      <div className="tab-header">
        <h2>Logs</h2>
        <div className="log-controls">
          <select value={view} onChange={e => setView(e.target.value)}>
            <option value="runtime">Runtime (stdout/stderr)</option>
            <option value="access">HTTP access</option>
          </select>
          {view === 'runtime' && (
            <select value={lines} onChange={e => setLines(Number(e.target.value))}>
              <option value={50}>50 lines</option>
              <option value={100}>100 lines</option>
              <option value={250}>250 lines</option>
              <option value={500}>500 lines</option>
            </select>
          )}
          <label className="checkbox-label">
            <span className={`mini-toggle sm ${autoRefresh ? 'on' : ''}`} role="switch"
              aria-checked={autoRefresh} aria-label="Auto-refresh"
              onClick={() => setAutoRefresh(!autoRefresh)} />
            Auto-refresh
          </label>
          <button onClick={load}>Refresh</button>
        </div>
      </div>
      <p className="hint">{view === 'runtime'
        ? 'What your app prints while it runs — its own output and any errors. Useful for debugging.'
        : 'The web requests your app received (who hit it, and what came back). Turn this on in Settings if it’s empty.'}</p>

      {error && <div className="error">{error}</div>}

      {view === 'runtime' && (
        <pre className="log-viewer" ref={logRef}>
          {logs || 'No logs available. The app may not be running yet.'}
        </pre>
      )}

      {view === 'access' && access && (
        access.enabled === false ? (
          <EmptyState icon="logs" title="Request Logs Are Off"
            body={access.note || 'Turn on “Caddy access logs for deployed apps” in Settings and redeploy, and every request to this app will be listed here.'} />
        ) : (
          <div>
            <div className="access-pills" style={{ margin: '8px 0' }}>
              {Object.entries(access.statusCounts || {}).sort().map(([code, n]) => (
                <span key={code} className="pill">{code}: {n}</span>
              ))}
            </div>
            {(access.recent || []).length === 0 ? (
              <EmptyState icon="logs" title="No Requests Yet"
              body="Nothing has visited this app since logging was turned on." />
            ) : (
              <table className="data-table">
                <thead><tr><th>Time</th><th>Status</th><th>Method</th><th>Path</th><th>IP</th></tr></thead>
                <tbody>
                  {access.recent.map((e, i) => (
                    <tr key={i}>
                      <td>{e.ts ? new Date(e.ts * 1000).toLocaleTimeString() : '-'}</td>
                      <td>{e.status}</td>
                      <td>{e.method}</td>
                      <td><code>{e.uri}</code></td>
                      <td>{e.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      )}
    </div>
  );
}
