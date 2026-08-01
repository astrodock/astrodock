import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';

function rel(dateStr) {
  if (!dateStr) return '';
  const d = Date.now() - new Date(dateStr).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}
function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : (h > 0 ? `${h}h ${m}m` : `${m}m`);
}
const SEV_LED = { critical: 'crit', warning: 'warn', info: 'ok' };

export default function OverviewPage() {
  const [health, setHealth] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [events, setEvents] = useState([]);
  const navigate = useNavigate();

  async function load() {
    try { setHealth(await api.getHealth()); } catch { /* ignore */ }
    try { setPlatform(await api.getPlatformHealth()); } catch { /* ignore */ }
    try { const e = await api.getEvents({ limit: 8 }); setEvents(e.events || []); } catch { /* ignore */ }
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  if (!health) return <p style={{ color: 'var(--text-3)' }}>Loading…</p>;

  const apps = health.apps || [];
  const server = health.server || {};
  const total = apps.length;
  const up = apps.filter((a) => a.health === 'healthy').length;
  const down = apps.filter((a) => a.health === 'down');
  const degraded = apps.filter((a) => a.health === 'degraded');
  const diskPct = server.disk?.usedPercent || 0;
  const memPct = server.memory?.usedPercent || 0;

  const attention = [];
  down.forEach((a) => attention.push({ sev: 'crit', title: `${a.name} is down`, sub: `failed ${a.consecutiveFailures || 0} health checks`, to: `/apps/${a.slug}`, go: 'View →' }));
  degraded.forEach((a) => attention.push({ sev: 'warn', title: `${a.name} is degraded`, sub: 'responding slowly or intermittently', to: `/apps/${a.slug}`, go: 'View →' }));
  if (diskPct >= 85) attention.push({ sev: 'warn', title: 'Disk almost full', sub: `${diskPct}% used`, to: '/settings', go: 'Settings →' });
  const isDegraded = attention.length > 0;

  const feed = events.map((ev) => ({
    led: SEV_LED[ev.severity] || 'ok',
    name: ev.appSlug || ev.category,
    ev: ev.message || ev.type,
    by: (ev.actor && ev.actor !== 'system') ? ev.actor : null,
    t: rel(ev.createdAt)
  }));

  // `starting` = one failed probe, not yet confirmed; usually a container still booting.
  const dep = (p, okV, downV) => !p ? ['', '—']
    : p.ok ? ['ok', okV]
      : p.starting ? ['warn', 'starting…']
        : ['crit', p.error ? 'down' : downV];
  const deps = platform ? [
    ['Database', ...dep(platform.database, `${platform.database?.responseTime != null ? '' : ''}ok`, 'down')],
    ['Object store', ...dep(platform.objectstore, 'ok', 'down')],
    ['Runner', ...dep(platform.runner, 'ok', 'down')],
    ['TLS cert', platform.cert?.skipped ? 'ok' : (platform.cert?.ok ? 'ok' : 'warn'),
      platform.cert?.skipped ? 'n/a' : (platform.cert?.daysLeft != null ? `${platform.cert.daysLeft}d` : (platform.cert?.ok ? 'ok' : 'error'))]
  ] : [];

  return (
    <div>
      <PageHeader
        title="Overview"
        note={`updated ${rel(health.checkedAt)}`}
        description="Everything at a glance: what is running, what needs attention, and what changed recently."
      />

      <section className={`hero ${isDegraded ? 'degraded' : ''}`}>
        <div className="beacon"><span className="ring" /><span className="ring" /><span className="core" /></div>
        <div className="hero-text">
          <div className="hero-state">{isDegraded ? `${attention.length} ${attention.length === 1 ? 'thing needs' : 'things need'} attention` : 'All systems nominal'}</div>
          <div className="hero-sub">{up} of {total} apps online · {attention.length} open {attention.length === 1 ? 'alert' : 'alerts'} · disk {diskPct}%</div>
        </div>
        <div className="hero-meta"><label>Uptime</label><b>{fmtUptime(server.uptime)}</b></div>
      </section>

      <section className={`attn-block ${isDegraded ? 'loud' : 'calm'}`}>
        {isDegraded ? (
          <>
            <div className="attn-head">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2 1.5 13.5h13L8 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6.3v3.4M8 11.5v.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              Needs attention <span className="attn-count">{attention.length}</span>
            </div>
            {attention.map((a, i) => (
              <div className="att-item" key={i} onClick={() => navigate(a.to)}>
                <span className={`led ${a.sev}`} />
                <div className="att-body"><b>{a.title}</b><span>{a.sub}</span></div>
                <span className="att-go">{a.go}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="att-empty">
            <div className="att-check"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M5 10.5 8.5 14 15 6.5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
            <div><b>All clear</b><span style={{ display: 'block' }}>nothing needs your attention</span></div>
          </div>
        )}
      </section>

      <section className="telemetry">
        <div className="tile">
          <div className="tile-top"><label>Apps</label><span className={`tile-dot ${down.length ? 'crit' : ''}`} /></div>
          <div className="tile-val">{up}<small> / {total}</small></div>
          <div className={`tile-foot ${down.length ? 'bad' : 'good'}`}>{down.length ? `${down.length} down` : 'all online'}</div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Disk</label><span className={`tile-dot ${diskPct >= 85 ? 'crit' : ''}`} /></div>
          <div className="tile-val">{diskPct}<small>%</small></div>
          <div className="meter"><i className={diskPct >= 85 ? 'crit' : ''} style={{ width: `${diskPct}%` }} /></div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Memory</label><span className={`tile-dot ${memPct >= 85 ? 'crit' : ''}`} /></div>
          <div className="tile-val">{memPct}<small>%</small></div>
          <div className="meter"><i className={memPct >= 85 ? 'crit' : ''} style={{ width: `${memPct}%` }} /></div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Alerts</label><span className={`tile-dot ${attention.length ? 'crit' : ''}`} /></div>
          <div className="tile-val">{attention.length}</div>
          <div className={`tile-foot ${attention.length ? 'bad' : 'good'}`}>{attention.length ? 'need attention' : 'all clear'}</div>
        </div>
      </section>

      <section className="ov-lower">
        <div className="panel">
          <div className="panel-h"><h2>Live Activity</h2><span className="panel-live">live</span></div>
          <div className="feed">
            {feed.length === 0 ? <EmptyState icon="activity" title="Nothing Yet"
              body="Deploys and platform events show up here as they happen." /> : feed.map((f, i) => (
              <div className="frow" key={i}>
                <span className={`led ${f.led}`} />
                <span className="frow-name">{f.name}</span>
                <span className="frow-ev">{f.ev}</span>
                {f.by && <span className="frow-by">by {f.by}</span>}
                <time>{f.t}</time>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Platform</h2></div>
          <div className="deps">
            {deps.length === 0 ? <div className="dep"><span className="led" /><label>checking…</label></div> : deps.map(([n, st, v]) => (
              <div className="dep" key={n}><span className={`led ${st}`} /><label>{n}</label><span className={`dep-v ${st}`}>{v}</span></div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
