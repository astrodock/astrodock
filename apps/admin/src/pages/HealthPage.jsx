import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost } from '../lib/appUrl';

const STATUS_CONFIG = {
  healthy:  { label: 'Healthy',  dotClass: 'active',   textClass: 'health-healthy' },
  degraded: { label: 'Degraded', dotClass: 'warning',  textClass: 'health-degraded' },
  down:     { label: 'Down',     dotClass: 'errored',  textClass: 'health-down' },
  stopped:  { label: 'Stopped',  dotClass: 'inactive', textClass: 'health-stopped' },
  unknown:  { label: 'Checking', dotClass: 'inactive', textClass: 'health-stopped' }
};

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatProcUptime(procUptime) {
  if (!procUptime) return '-';
  const seconds = Math.floor((Date.now() - procUptime) / 1000);
  return formatUptime(seconds);
}

function formatTime(dateStr) {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(dateStr).toLocaleString();
}

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const result = await api.getHealth();
      setData(result);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  if (!data && !error) return <p>Loading...</p>;

  const server = data?.server;
  const apps = data?.apps || [];
  const downCount = apps.filter(a => a.health === 'down').length;
  const degradedCount = apps.filter(a => a.health === 'degraded').length;

  return (
    <div>
      <div className="page-header">
        <h1>Health</h1>
        {data && (
          <span className="health-updated">
            Last checked: {formatTime(data.checkedAt)}
          </span>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {downCount > 0 && (
        <div className="health-alert health-alert-danger">
          {downCount} app{downCount > 1 ? 's' : ''} down
        </div>
      )}
      {degradedCount > 0 && (
        <div className="health-alert health-alert-warning">
          {degradedCount} app{degradedCount > 1 ? 's' : ''} degraded
        </div>
      )}

      {server && (
        <div className="health-metrics">
          <div className="metric-card">
            <div className="metric-label">Server Uptime</div>
            <div className="metric-value">{formatUptime(server.uptime)}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Memory</div>
            <div className="metric-value">{server.memory.usedPercent}%</div>
            <div className="metric-sub">
              {formatBytes(server.memory.total - server.memory.free)} / {formatBytes(server.memory.total)}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">CPU Load</div>
            <div className="metric-value">{server.cpu.load1m.toFixed(2)}</div>
            <div className="metric-sub">
              5m: {server.cpu.load5m.toFixed(2)} &middot; 15m: {server.cpu.load15m.toFixed(2)}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Disk</div>
            <div className="metric-value">{server.disk.usedPercent}%</div>
            <div className="metric-sub">
              {server.disk.used} / {server.disk.total}
            </div>
          </div>
        </div>
      )}

      {apps.length === 0 ? (
        <p className="empty-state">No provisioned apps to monitor.</p>
      ) : (
        <table className="data-table clickable">
          <thead>
            <tr>
              <th>App</th>
              <th>Status</th>
              <th>Response</th>
              <th>Memory</th>
              <th>CPU</th>
              <th>Uptime</th>
              <th>Restarts</th>
              <th>Last Check</th>
            </tr>
          </thead>
          <tbody>
            {apps.map(app => {
              const cfg = STATUS_CONFIG[app.health] || STATUS_CONFIG.unknown;
              return (
                <tr key={app.slug} onClick={() => navigate(`/apps/${app.slug}`)}>
                  <td>
                    <strong>{app.name}</strong>
                    <span className="health-slug">{appHost(app.subdomain)}</span>
                  </td>
                  <td>
                    <span className="process-status-inline">
                      <span className={`process-dot-sm ${cfg.dotClass}`} />
                      <span className={cfg.textClass}>{cfg.label}</span>
                    </span>
                  </td>
                  <td>{app.responseTime != null ? `${app.responseTime}ms` : '-'}</td>
                  <td>{app.proc ? formatBytes(app.proc.memory) : '-'}</td>
                  <td>{app.proc ? `${app.proc.cpu}%` : '-'}</td>
                  <td>{app.proc ? formatProcUptime(app.proc.uptime) : '-'}</td>
                  <td>{app.proc ? app.proc.restarts : '-'}</td>
                  <td>{formatTime(app.lastCheck)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
