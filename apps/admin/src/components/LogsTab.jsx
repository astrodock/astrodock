import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import Select from './Select';

export default function LogsTab({ app }) {
  const [view, setView] = useState('runtime'); // runtime | access
  const [logs, setLogs] = useState('');
  const [access, setAccess] = useState(null);
  const [lines, setLines] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const logRef = useRef(null);
  const stick = useRef(true);

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

  // Follow the tail only if you are already at the tail. Auto-refresh used to
  // snap the view to the bottom every five seconds, so reading anything further
  // up while an app was busy was impossible.
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs, q]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  const shown = q.trim()
    ? (logs || '').split('\n').filter((l) => l.toLowerCase().includes(q.trim().toLowerCase())).join('\n')
    : logs;

  return (
    <div>
      <div className="tab-header">
        <h2>Logs</h2>
        <div className="log-controls">
          <Select value={view} onChange={setView} options={[
            { value: 'runtime', label: 'Runtime', description: 'What your app itself prints — console output and crashes.' },
            { value: 'access', label: 'HTTP access', description: 'One line per request that reached this app.' }
          ]} />
          {view === 'runtime' && (
            <Select value={lines} onChange={setLines} options={[
              { value: 50, label: '50 lines' },
              { value: 100, label: '100 lines' },
              { value: 250, label: '250 lines' },
              { value: 500, label: '500 lines' }
            ]} />
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
        <>
          <div className="log-filter">
            <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck="false"
              placeholder="Filter these lines…" />
            {q && (
              <span className="log-filter-count">
                {shown ? `${shown.split('\n').length} matching` : 'no matches'}
                <button type="button" onClick={() => setQ('')}>Clear</button>
              </span>
            )}
          </div>
          <pre className="log-viewer" ref={logRef} onScroll={onScroll}>
            {logs
              ? (shown || `Nothing in the last ${lines} lines matches “${q}”.`)
              : 'No logs available. The app may not be running yet.'}
          </pre>
        </>
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
