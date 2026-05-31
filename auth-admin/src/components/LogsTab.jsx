import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';

export default function LogsTab({ app }) {
  const [logs, setLogs] = useState('');
  const [lines, setLines] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);

  async function load() {
    try {
      const data = await api.getAppLogs(app.slug, lines);
      setLogs(data.logs);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [app.slug, lines]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, app.slug, lines]);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div>
      <div className="tab-header">
        <h2>Application Logs</h2>
        <div className="log-controls">
          <select value={lines} onChange={e => setLines(Number(e.target.value))}>
            <option value={50}>50 lines</option>
            <option value={100}>100 lines</option>
            <option value={250}>250 lines</option>
            <option value={500}>500 lines</option>
          </select>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <pre className="log-viewer" ref={logRef}>
        {logs || 'No logs available. The app may not be running yet.'}
      </pre>
    </div>
  );
}
