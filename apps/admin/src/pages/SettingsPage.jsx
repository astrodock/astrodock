import { useState, useEffect } from 'react';
import * as api from '../lib/api';

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
        <label className="checkbox-label" style={{ marginTop: 6 }}><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> Rule is on</label>

        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? 'Saving…' : (editing ? 'Save' : 'Create rule')}</button></div>
      </form>
    </div>
  );
}

function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

const EMAIL_KEYS = ['alerts.email_to', 'alerts.email_from'];
const LOG_KEYS = ['logging.page_view_ip', 'logging.auth_log_retention_days', 'logging.page_view_retention_days', 'logging.app_access_logs', 'alerts.disk_threshold_percent'];

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [diagnostics, setDiagnostics] = useState(null);
  const [readiness, setReadiness] = useState([]);
  const [rules, setRules] = useState([]);
  const [backups, setBackups] = useState(null);
  const [backingUp, setBackingUp] = useState(false);
  const [draft, setDraft] = useState({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [editRule, setEditRule] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const [s, r, b] = await Promise.all([api.getSettings(), api.getNotificationRules(), api.getBackups().catch(() => null)]);
      setSettings(s.settings || []); setDiagnostics(s.diagnostics || null); setReadiness(s.readiness || []);
      setRules(r.rules || []); setBackups(b); setError('');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 3000); }

  const valueOf = (key) => (key in draft ? draft[key] : settings.find((s) => s.key === key)?.value);
  const dirty = Object.keys(draft).length;

  async function saveSettings() {
    setSavingSettings(true); setError('');
    try { await api.updateSettings(draft); setDraft({}); await load(); flash('Settings saved.'); }
    catch (err) { setError(err.message); } finally { setSavingSettings(false); }
  }
  async function triggerBackup() {
    setBackingUp(true); setError('');
    try { await api.runBackup(); await load(); flash('Backup complete.'); }
    catch (err) { setError(`Backup failed: ${err.message}`); } finally { setBackingUp(false); }
  }
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

  function setField(s, value) { setDraft({ ...draft, [s.key]: s.type === 'int' ? Number(value) : value }); }
  function Field({ s }) {
    if (!s) return null;
    return (
      <div className="field">
        <div className="lab"><b>{s.label}</b></div>
        <div className="ctl">
          {s.type === 'enum' ? (
            <div className="seg">{s.values.map((v) => <button key={v} type="button" className={String(valueOf(s.key)) === String(v) ? 'sel' : ''} onClick={() => setField(s, v)}>{v}</button>)}</div>
          ) : (
            <input className={s.type === 'int' ? 'num' : ''} type={s.type === 'int' ? 'number' : 'text'} value={valueOf(s.key) ?? ''} onChange={(e) => setField(s, e.target.value)} style={{ marginTop: 0, width: s.type === 'int' ? 90 : 260 }} />
          )}
          <span className={`src ${s.source === 'override' ? 'override' : ''}`}>{s.source}</span>
        </div>
      </div>
    );
  }
  const byKey = (k) => settings.find((s) => s.key === k);

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

      {/* save bar */}
      <div className={`savebar ${dirty ? 'on' : ''}`}>
        {dirty ? (
          <><span className="led warn" /><b>{dirty} unsaved {dirty === 1 ? 'change' : 'changes'}</b><span style={{ flex: 1 }} />
            <button onClick={() => setDraft({})}>Discard</button>
            <button className="primary" onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving…' : 'Save changes'}</button></>
        ) : <span className="saved"><span className="led ok" /> All changes saved</span>}
      </div>

      {/* Notifications */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Notifications</h2><p>What Astrodock tells you about, and how. With no rules, it emails the alert address for health &amp; deploy events at warning+.</p></div><button className="primary" onClick={() => setEditRule({})}>+ Add rule</button></div>
        {rules.length === 0 ? <p className="empty-state">No rules.</p> : (
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
        <div className="sec-head"><div><h2>Email</h2><p>The email account Astrodock uses to send you alerts.</p></div></div>
        <div className="field-panel">
          <Field s={byKey('alerts.email_to')} />
          <Field s={byKey('alerts.email_from')} />
          <div className="field">
            <div className="lab"><b>Email service</b><span className="desc">The provider key is set at install for now.</span></div>
            <div className="ctl">
              {diagnostics?.email?.resendConfigured ? <span className="chip ok">connected</span> : <span className="chip warn">not set up</span>}
              <span className="soon">in-app setup soon</span>
            </div>
          </div>
        </div>
      </section>

      {/* Logs & privacy */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Logs &amp; privacy</h2><p>What gets recorded, how long it’s kept, and how much visitor data you store.</p></div></div>
        <div className="field-panel">{LOG_KEYS.map((k) => <Field key={k} s={byKey(k)} />)}</div>
        <p className="store-note"><b>Where this lives:</b> sign-ins, page visits, the audit trail, and deploy logs are in your database; app runtime logs sit on the server’s disk. Everything stays on your box. <span className="soon">off-box forwarding soon</span></p>
      </section>

      {/* Backups */}
      {backups && (
        <section className="set-section">
          <div className="sec-head"><div><h2>Backups</h2><p>A copy of your database is saved {backups.config.intervalHours > 0 ? `every ${backups.config.intervalHours}h` : '(schedule off)'}, keeping the last {backups.config.keep}, in <code>{backups.config.dir}</code>.</p></div><button className="primary" onClick={triggerBackup} disabled={backingUp}>{backingUp ? 'Backing up…' : 'Back up now'}</button></div>
          {(backups.backups || []).length === 0 ? <p className="empty-state">No backups recorded yet.</p> : (
            <table className="data-table">
              <thead><tr><th>When</th><th>Result</th><th>Size</th><th>How</th><th></th></tr></thead>
              <tbody>
                {backups.backups.slice(0, 10).map((b) => (
                  <tr key={b.id}>
                    <td>{new Date(b.createdAt).toLocaleString()}</td>
                    <td><span className="led" style={{ background: b.status === 'success' ? 'var(--accent)' : 'var(--danger)', marginRight: 8 }} />{b.status}{b.error && <span className="hint"> — {b.error.slice(0, 60)}</span>}</td>
                    <td>{fmtBytes(b.sizeBytes)}</td>
                    <td>{b.trigger}</td>
                    <td className="actions"><span className="soon">download / restore soon</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* System info */}
      {diagnostics && (
        <section className="set-section">
          <div className="sec-head"><div><h2>System info</h2><p>Set when Astrodock was installed — read-only here, secrets masked.</p></div></div>
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
