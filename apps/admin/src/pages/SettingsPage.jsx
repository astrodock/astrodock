import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import SettingsGroup from '../components/SettingsGroup';
import EmailSetup from '../components/EmailSetup';
import BackupsSection from '../components/BackupsSection';

const CATEGORIES = [
  { key: 'health', label: 'App health' }, { key: 'deploy', label: 'Deploys' },
  { key: 'pages', label: 'Pages' }, { key: 'auth', label: 'Sign-ins' },
  { key: 'audit', label: 'Setting changes' }, { key: 'system', label: 'System' }
];
const SEVERITIES = [
  { v: 'info', label: 'Anything' }, { v: 'warning', label: 'Warnings & up' }, { v: 'critical', label: 'Only urgent' }
];
const FORMATS = ['json', 'slack', 'discord'];
const SEVRANK = { info: 0, warning: 1, critical: 2 };
const SEVCOLOR = { critical: 'var(--danger)', warning: 'var(--warning)', info: 'var(--text-3)' };
const sevWord = (s) => (s === 'critical' ? 'urgent' : s);

const EVENTS = {
  health: [{ l: 'An app goes down', s: 'critical' }, { l: 'An app comes back', s: 'warning' }],
  deploy: [{ l: 'A deploy fails', s: 'critical' }, { l: 'A deploy succeeds', s: 'info' }],
  pages: [{ l: 'A page is published', s: 'info' }, { l: 'A page is deleted', s: 'info' }],
  auth: [{ l: 'Repeated failed sign-ins', s: 'warning' }],
  audit: [{ l: 'A platform setting changes', s: 'info' }, { l: 'A custom domain is added', s: 'info' }],
  system: [{ l: 'A backup fails', s: 'critical' }, { l: 'Disk is filling up', s: 'warning' }, { l: 'A core service is unreachable', s: 'critical' }, { l: 'A certificate is expiring', s: 'warning' }]
};
function previewEvents(categories, minSeverity) {
  const cats = categories.length ? categories : Object.keys(EVENTS);
  const mr = SEVRANK[minSeverity];
  const out = [];
  cats.forEach((c) => (EVENTS[c] || []).forEach((e) => { if (SEVRANK[e.s] >= mr) out.push(e); }));
  return out;
}

const emptyRule = { name: '', enabled: true, channel: 'email', target: { to: '', url: '', format: 'json' }, categories: [], minSeverity: 'warning', appScope: [] };

function RuleModal({ initial, onClose, onSaved }) {
  const [r, setR] = useState(() => ({ ...emptyRule, ...initial, target: { ...emptyRule.target, ...(initial?.target || {}) }, categories: initial?.categories || [], appScope: initial?.appScope || [] }));
  const [scopeText, setScopeText] = useState((initial?.appScope || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!initial?.id;
  const toggleCat = (c) => setR((cur) => ({ ...cur, categories: cur.categories.includes(c) ? cur.categories.filter((x) => x !== c) : [...cur.categories, c] }));
  const preview = previewEvents(r.categories, r.minSeverity);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    const payload = {
      name: r.name, enabled: r.enabled, channel: r.channel,
      target: r.channel === 'email' ? { to: r.target.to.trim() } : { url: r.target.url.trim(), format: r.target.format },
      categories: r.categories, minSeverity: r.minSeverity,
      appScope: scopeText.split(',').map((s) => s.trim()).filter(Boolean)
    };
    try { editing ? await api.updateNotificationRule(initial.id, payload) : await api.createNotificationRule(payload); onSaved(); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{editing ? 'Edit notification rule' : 'New notification rule'}</h2>
        {error && <div className="error">{error}</div>}

        <label>Give it a name<input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Slack #ops when something fails" autoFocus /></label>

        <label style={{ marginBottom: 6 }}>How should we tell you?</label>
        <div className="seg" style={{ marginBottom: 16 }}>
          <button type="button" className={r.channel === 'email' ? 'sel' : ''} onClick={() => setR({ ...r, channel: 'email' })}>Email</button>
          <button type="button" className={r.channel === 'webhook' ? 'sel' : ''} onClick={() => setR({ ...r, channel: 'webhook' })}>Webhook</button>
        </div>

        {r.channel === 'email' ? (
          <label>Email address<input type="email" value={r.target.to} onChange={(e) => setR({ ...r, target: { ...r.target, to: e.target.value } })} placeholder="alerts@example.com" required /></label>
        ) : (
          <>
            <label>Webhook URL<input value={r.target.url} onChange={(e) => setR({ ...r, target: { ...r.target, url: e.target.value } })} placeholder="https://hooks.slack.com/services/…" required /></label>
            <label>Payload format<select value={r.target.format} onChange={(e) => setR({ ...r, target: { ...r.target, format: e.target.value } })}>{FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          </>
        )}

        <label style={{ marginBottom: 6 }}>What should this rule cover? <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>— pick none to cover everything</span></label>
        <div className="seg-pills" style={{ marginBottom: 16 }}>
          {CATEGORIES.map((c) => (
            <button type="button" key={c.key} className={`pillbtn ${r.categories.includes(c.key) ? 'sel' : ''}`} onClick={() => toggleCat(c.key)}>{c.label}</button>
          ))}
        </div>

        <label style={{ marginBottom: 6 }}>How important does it need to be?</label>
        <div className="seg" style={{ marginBottom: 8 }}>
          {SEVERITIES.map((s) => <button type="button" key={s.v} className={r.minSeverity === s.v ? 'sel' : ''} onClick={() => setR({ ...r, minSeverity: s.v })}>{s.label}</button>)}
        </div>

        <label style={{ marginBottom: 6 }}>You’ll be notified about</label>
        <div className="preview-box">
          {preview.length === 0 ? <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Nothing matches yet.</span> : preview.map((e, i) => (
            <div className="prow" key={i}><span className="led" style={{ background: SEVCOLOR[e.s], boxShadow: 'none', width: 6, height: 6 }} />{e.l}<span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', color: SEVCOLOR[e.s] }}>{sevWord(e.s)}</span></div>
          ))}
        </div>

        <label style={{ marginTop: 16 }}>Limit to apps <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>(comma-separated slugs; blank = all)</span><input value={scopeText} onChange={(e) => setScopeText(e.target.value)} placeholder="blog, notes" /></label>
        <div className="opt-list" style={{ marginTop: 10 }}>
          <div className={`opt-row ${r.enabled ? 'on' : ''}`}>
            <span className="name">Rule is on</span>
            <span className={`mini-toggle ${r.enabled ? 'on' : ''}`} role="switch" aria-checked={r.enabled}
              aria-label="Rule is on" onClick={() => setR({ ...r, enabled: !r.enabled })} />
          </div>
        </div>

        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? 'Saving…' : (editing ? 'Save' : 'Create rule')}</button></div>
      </form>
    </div>
  );
}

const ALERT_KEYS = ['alerts.email_to', 'alerts.disk_threshold_percent'];
const SECURITY_KEYS = ['security.require_mfa'];
const LOG_KEYS = ['logging.page_view_ip', 'logging.auth_log_retention_days',
  'logging.page_view_retention_days', 'logging.app_access_logs'];

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [diagnostics, setDiagnostics] = useState(null);
  const [readiness, setReadiness] = useState([]);
  const [email, setEmail] = useState(null);
  const [rules, setRules] = useState([]);
  const [backups, setBackups] = useState(null);
  const [editRule, setEditRule] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const [s, r, b] = await Promise.all([api.getSettings(), api.getNotificationRules(), api.getBackups().catch(() => null)]);
      setSettings(s.settings || []); setDiagnostics(s.diagnostics || null); setReadiness(s.readiness || []);
      setEmail(s.email || null); setRules(r.rules || []); setBackups(b); setError('');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  const alertTo = settings.find((s) => s.key === 'alerts.email_to')?.value || '';
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 3000); }

  async function removeRule(rule) {
    if (!confirm(`Delete notification rule "${rule.name || rule.channel}"?`)) return;
    try { await api.deleteNotificationRule(rule.id); await load(); } catch (err) { setError(err.message); }
  }
  async function toggleRule(rule) {
    try { await api.updateNotificationRule(rule.id, { enabled: !rule.enabled }); await load(); } catch (err) { setError(err.message); }
  }
  async function testRule(rule) {
    setError('');
    try { const { result } = await api.testNotification({ channel: rule.channel, target: rule.target }); flash(result.status === 'sent' ? `Test sent via ${rule.channel} → ${result.target}` : `Test ${result.status}: ${result.error || 'no recipient'}`); }
    catch (err) { setError(err.message); }
  }


  return (
    <div className="settings-page">
      <div className="page-header"><h1>Settings</h1></div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="provision-banner"><strong>{msg}</strong></div>}

      {/* readiness */}
      {readiness.length > 0 && (
        <div className="ready-grid">
          {readiness.map((c) => (
            <div className={`rcard ${c.ok ? 'ok' : (c.level === 'critical' ? 'crit' : 'warn')}`} key={c.key}>
              <span className={`led ${c.ok ? 'ok' : (c.level === 'critical' ? 'crit' : 'warn')}`} />
              <span>{c.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Notifications */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Notifications</h2><p>What Astrodock tells you about, and how. With no rules, it emails the alert address for health &amp; deploy events at warning+.</p></div><button className="primary" onClick={() => setEditRule({})}>+ Add Rule</button></div>
        {rules.length === 0 ? <EmptyState icon="settings" title="No Custom Rules"
          body="Astrodock already emails the alert address about health and deploy problems. Add a rule to send somewhere else — a Slack or Discord webhook, a second address — or to change what counts as worth telling you about." /> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>How</th><th>Where</th><th>About</th><th>Min sev.</th><th>On</th><th></th></tr></thead>
            <tbody>
              {rules.map((rule, i) => (
                <tr key={rule.id || `implicit-${i}`}>
                  <td><strong>{rule.name || '—'}</strong>{rule.implicit && <span className="pill" style={{ marginLeft: 6 }}>built-in</span>}</td>
                  <td>{rule.channel}</td>
                  <td><code>{rule.channel === 'email' ? rule.target?.to : rule.target?.url}</code></td>
                  <td>{(rule.categories && rule.categories.length) ? rule.categories.join(', ') : 'all'}</td>
                  <td>{rule.minSeverity}</td>
                  <td>{rule.implicit ? <span className="chip ok">always</span> : <span className={`mini-toggle ${rule.enabled ? 'on' : ''}`} onClick={() => toggleRule(rule)} title="Turn on/off" />}</td>
                  <td className="actions">
                    <button onClick={() => testRule(rule)}>Test</button>
                    {!rule.implicit && <button onClick={() => setEditRule(rule)}>Edit</button>}
                    {!rule.implicit && <button className="danger" onClick={() => removeRule(rule)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Email */}
      <section className="set-section">
        <div className="sec-head">
          <div>
            <h2>Email</h2>
            <p>How Astrodock sends you alerts. Nothing signs in by email, so leaving this unset only means alerts stay in the dashboard.</p>
          </div>
          {email && <span className={`chip ${email.usable ? 'ok' : 'warn'}`}>{email.usable ? `via ${email.provider}` : 'not set up'}</span>}
        </div>
        <div className="field-panel" style={{ padding: '20px 22px' }}>
          <EmailSetup initial={email} onSaved={load} testTo={alertTo} />
        </div>
      </section>

      <SettingsGroup
        title="Alerts"
        description="Where alerts go when a rule does not name its own recipient, and how full the disk gets before Astrodock says something."
        keys={ALERT_KEYS}
        settings={settings}
        onSave={api.updateSettings}
        onSaved={load}
      />

      <SettingsGroup
        title="Security"
        description="Applies to everyone who signs in to this dashboard."
        keys={SECURITY_KEYS}
        settings={settings}
        onSave={api.updateSettings}
        onSaved={load}
      />

      {/* Logs & privacy */}
      <SettingsGroup
        title="Logs & Privacy"
        description="What gets recorded, how long it is kept, and how much visitor data you store."
        keys={LOG_KEYS}
        settings={settings}
        onSave={api.updateSettings}
        onSaved={load}
      />
      <p className="store-note" style={{ marginTop: -22, marginBottom: 34 }}><b>Where this lives:</b> sign-ins, page visits, the audit trail, and deploy logs are in your database; app runtime logs sit on the server’s disk. Everything stays on your box. <span className="soon">off-box forwarding soon</span></p>

      <BackupsSection backups={backups} onChanged={load} />

      {/* System info */}
      {diagnostics && (
        <section className="set-section">
          <div className="sec-head"><div><h2>System Info</h2><p>Set when Astrodock was installed — read-only here, secrets masked.</p></div></div>
          <div className="diag">
            {Object.entries(diagnostics).map(([k, v]) => (
              <div className="drow" key={k}><label>{k}</label><div className="v">{typeof v === 'object' && v !== null ? Object.entries(v).map(([kk, vv]) => `${kk}: ${vv}`).join(' · ') : String(v)}</div></div>
            ))}
          </div>
        </section>
      )}

      <p className="store-note" style={{ marginTop: 8 }}><b>Coming soon:</b> lockdown mode (block public access while keeping the dashboard), and a danger zone (rotate keys, clear logs, remove all data) — these need backend work and land next.</p>

      {editRule && <RuleModal initial={editRule} onClose={() => setEditRule(null)} onSaved={() => { setEditRule(null); load(); }} />}
    </div>
  );
}
