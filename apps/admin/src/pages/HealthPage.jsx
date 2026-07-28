import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost } from '../lib/appUrl';
import EmptyState from '../components/EmptyState';

const STATUS_CONFIG = {
  healthy: { label: 'Healthy', dotClass: 'active', textClass: 'health-healthy' },
  degraded: { label: 'Degraded', dotClass: 'warning', textClass: 'health-degraded' },
  down: { label: 'Down', dotClass: 'errored', textClass: 'health-down' },
  stopped: { label: 'Stopped', dotClass: 'inactive', textClass: 'health-stopped' },
  unknown: { label: 'Checking', dotClass: 'inactive', textClass: 'health-stopped' }
};

function formatUptime(seconds) {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : (h > 0 ? `${h}h ${m}m` : `${m}m`);
}
function formatBytes(b) {
  if (!b) return '-';
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}
function formatProcUptime(p) { if (!p) return '-'; return formatUptime(Math.floor((Date.now() - p) / 1000)); }
function formatTime(dateStr) {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(dateStr).toLocaleString();
}
function depLabel(d) { if (!d) return { cls: 'inactive', text: 'unknown' }; return d.ok ? { cls: 'active', text: 'ok' } : { cls: 'errored', text: d.error || 'down' }; }

function Sparkline({ values, color, max }) {
  if (!values || values.length < 2) return <div className="spark-empty">collecting…</div>;
  const mx = max || Math.max(...values, 1);
  const w = 100, h = 30;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${(h - (Math.min(v, mx) / mx) * h).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} fillOpacity="0.08" stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [samples, setSamples] = useState([]);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const result = await api.getHealth();
      setData(result);
      if (result?.server) {
        setSamples((s) => [...s.slice(-29), { cpu: result.server.cpu.load1m, mem: result.server.memory.usedPercent, disk: result.server.disk.usedPercent }]);
      }
      setError('');
    } catch (err) { setError(err.message); }
    try { setPlatform(await api.getPlatformHealth()); } catch { /* non-fatal */ }
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  if (!data && !error) return <p style={{ color: 'var(--text-3)' }}>Loading…</p>;

  const server = data?.server;
  const apps = data?.apps || [];
  const downCount = apps.filter((a) => a.health === 'down').length;
  const degradedCount = apps.filter((a) => a.health === 'degraded').length;
  const cpuSeries = samples.map((s) => s.cpu);
  const memSeries = samples.map((s) => s.mem);
  const diskSeries = samples.map((s) => s.disk);

  return (
    <div>
      <div className="page-header">
        <h1>Health</h1>
        {data && <span className="health-updated">Last checked {formatTime(data.checkedAt)}</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {downCount > 0 && <div className="health-alert health-alert-danger">{downCount} app{downCount > 1 ? 's' : ''} down</div>}
      {degradedCount > 0 && <div className="health-alert health-alert-warning">{degradedCount} app{degradedCount > 1 ? 's' : ''} degraded</div>}

      {/* platform dependencies */}
      {platform && (
        <div className="deps deps-standalone">
          {[['database', 'Database'], ['objectstore', 'Object store'], ['runner', 'Runner']].map(([k, label]) => {
            const st = depLabel(platform[k]);
            return <div className="dep" key={k}><span className={`led ${st.cls === 'active' ? 'ok' : (st.cls === 'errored' ? 'crit' : '')}`} /><label>{label}</label><span className={`dep-v ${st.cls === 'active' ? 'ok' : 'crit'}`}>{st.text}</span></div>;
          })}
          {platform.cert && !platform.cert.skipped && (
            <div className="dep"><span className={`led ${platform.cert.ok ? 'ok' : 'warn'}`} /><label>TLS cert</label><span className="dep-v">{platform.cert.daysLeft != null ? `${platform.cert.daysLeft}d left` : (platform.cert.ok ? 'ok' : 'error')}</span></div>
          )}
        </div>
      )}

      {/* server vitals with live charts */}
      {server && (
        <div className="health-vitals">
          <div className="vcard">
            <div className="vhead"><span className="metric-label">CPU load</span><b>{server.cpu.load1m.toFixed(2)}</b></div>
            <Sparkline values={cpuSeries} color="var(--info)" />
            <div className="metric-sub">5m {server.cpu.load5m.toFixed(2)} · 15m {server.cpu.load15m.toFixed(2)}</div>
          </div>
          <div className="vcard">
            <div className="vhead"><span className="metric-label">Memory</span><b style={{ color: server.memory.usedPercent >= 85 ? 'var(--danger)' : undefined }}>{server.memory.usedPercent}%</b></div>
            <Sparkline values={memSeries} color={server.memory.usedPercent >= 85 ? 'var(--danger)' : 'var(--accent)'} max={100} />
            <div className="metric-sub">{formatBytes(server.memory.total - server.memory.free)} / {formatBytes(server.memory.total)}</div>
          </div>
          <div className="vcard">
            <div className="vhead"><span className="metric-label">Disk</span><b style={{ color: server.disk.usedPercent >= 85 ? 'var(--danger)' : undefined }}>{server.disk.usedPercent}%</b></div>
            <Sparkline values={diskSeries} color={server.disk.usedPercent >= 85 ? 'var(--danger)' : 'var(--accent)'} max={100} />
            <div className="metric-sub">{server.disk.used} / {server.disk.total}</div>
          </div>
          <div className="vcard">
            <div className="vhead"><span className="metric-label">Server uptime</span><b style={{ fontSize: 20 }}>{formatUptime(server.uptime)}</b></div>
            <div className="spark-empty" style={{ color: 'var(--text-3)' }}>since last reboot</div>
            <div className="metric-sub">{apps.length} app{apps.length === 1 ? '' : 's'} monitored</div>
          </div>
        </div>
      )}

      {/* per-app health */}
      {apps.length === 0 ? (
        <EmptyState icon="health" title="Nothing To Monitor Yet"
          body="Once an app is set up and running, its status, memory and response time show up here." />
      ) : (
        <table className="data-table clickable">
          <thead><tr><th>App</th><th>Status</th><th>Response</th><th>Memory</th><th>CPU</th><th>Uptime</th><th>Restarts</th><th>Last Check</th></tr></thead>
          <tbody>
            {apps.map((app) => {
              const cfg = STATUS_CONFIG[app.health] || STATUS_CONFIG.unknown;
              return (
                <tr key={app.slug} onClick={() => navigate(`/apps/${app.slug}`)}>
                  <td><strong>{app.name}</strong><span className="health-slug">{appHost(app.subdomain)}</span></td>
                  <td><span className="process-status-inline"><span className={`process-dot-sm ${cfg.dotClass}`} /><span className={cfg.textClass}>{cfg.label}</span></span></td>
                  <td>{app.responseTime != null ? `${app.responseTime} ms` : '-'}</td>
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
