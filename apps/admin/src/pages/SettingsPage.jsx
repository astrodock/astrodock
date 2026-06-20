import { useState, useEffect } from 'react';
import * as api from '../lib/api';

const CATEGORIES = ['health', 'deploy', 'pages', 'auth', 'audit', 'system'];
const SEVERITIES = ['info', 'warning', 'critical'];
const FORMATS = ['json', 'slack', 'discord'];

const emptyRule = {
  name: '', enabled: true, channel: 'email',
  target: { to: '', url: '', format: 'json' },
  categories: [], minSeverity: 'warning', appScope: []
};

function RuleModal({ initial, onClose, onSaved }) {
  const [r, setR] = useState(() => ({
    ...emptyRule, ...initial,
    target: { ...emptyRule.target, ...(initial?.target || {}) },
    categories: initial?.categories || [], appScope: initial?.appScope || []
  }));
  const [scopeText, setScopeText] = useState((initial?.appScope || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!initial?.id;

  function toggleCat(c) {
    setR((cur) => ({ ...cur, categories: cur.categories.includes(c) ? cur.categories.filter((x) => x !== c) : [...cur.categories, c] }));
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    const payload = {
      name: r.name, enabled: r.enabled, channel: r.channel,
      target: r.channel === 'email' ? { to: r.target.to.trim() } : { url: r.target.url.trim(), format: r.target.format },
      categories: r.categories,
      minSeverity: r.minSeverity,
      appScope: scopeText.split(',').map((s) => s.trim()).filter(Boolean)
    };
    try {
      if (editing) await api.updateNotificationRule(initial.id, payload);
      else await api.createNotificationRule(payload);
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{editing ? 'Edit notification rule' : 'New notification rule'}</h2>
        {error && <div className="error">{error}</div>}

        <label>Name
          <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Slack #ops on failures" autoFocus />
        </label>

        <label>Channel</label>
        <div className="access-pills" style={{ margin: '2px 0 6px' }}>
          <label className="checkbox-pill"><input type="radio" name="channel" checked={r.channel === 'email'} onChange={() => setR({ ...r, channel: 'email' })} /> email</label>
          <label className="checkbox-pill"><input type="radio" name="channel" checked={r.channel === 'webhook'} onChange={() => setR({ ...r, channel: 'webhook' })} /> webhook</label>
        </div>

        {r.channel === 'email' ? (
          <label>Send to
            <input type="email" value={r.target.to} onChange={(e) => setR({ ...r, target: { ...r.target, to: e.target.value } })} placeholder="alerts@example.com" required />
          </label>
        ) : (
          <>
            <label>Webhook URL
              <input value={r.target.url} onChange={(e) => setR({ ...r, target: { ...r.target, url: e.target.value } })} placeholder="https://hooks.slack.com/services/…" required />
            </label>
            <label>Payload format
              <select value={r.target.format} onChange={(e) => setR({ ...r, target: { ...r.target, format: e.target.value } })}>
                {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          </>
        )}

        <label>Events <span className="hint" style={{ display: 'inline' }}>(none selected = all categories)</span></label>
        <div className="access-pills" style={{ margin: '2px 0 6px', flexWrap: 'wrap' }}>
          {CATEGORIES.map((c) => (
            <label key={c} className="checkbox-pill"><input type="checkbox" checked={r.categories.includes(c)} onChange={() => toggleCat(c)} /> {c}</label>
          ))}
        </div>

        <label>Minimum severity
          <select value={r.minSeverity} onChange={(e) => setR({ ...r, minSeverity: e.target.value })}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label>Limit to apps <span className="hint" style={{ display: 'inline' }}>(comma-separated slugs; blank = all)</span>
          <input value={scopeText} onChange={(e) => setScopeText(e.target.value)} placeholder="blog, notes" />
        </label>

        <label className="checkbox-pill" style={{ width: 'fit-content' }}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> enabled
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : (editing ? 'Save' : 'Create')}</button>
        </div>
      </form>
    </div>
  );
}

function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [diagnostics, setDiagnostics] = useState(null);
  const [readiness, setReadiness] = useState([]);
  const [rules, setRules] = useState([]);
  const [backups, setBackups] = useState(null);
  const [backingUp, setBackingUp] = useState(false);
  const [draft, setDraft] = useState({});           // pending operational-setting edits
  const [savingSettings, setSavingSettings] = useState(false);
  const [editRule, setEditRule] = useState(null);    // {} = new, {id,…} = edit, null = closed
  const [testMsg, setTestMsg] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const [s, r, b] = await Promise.all([api.getSettings(), api.getNotificationRules(), api.getBackups().catch(() => null)]);
      setSettings(s.settings || []);
      setDiagnostics(s.diagnostics || null);
      setReadiness(s.readiness || []);
      setRules(r.rules || []);
      setBackups(b);
      setError('');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function triggerBackup() {
    setBackingUp(true); setError('');
    try { await api.runBackup(); await load(); }
    catch (err) { setError(`Backup failed: ${err.message}`); } finally { setBackingUp(false); }
  }

  const valueOf = (key) => (key in draft ? draft[key] : settings.find((s) => s.key === key)?.value);
  const dirty = Object.keys(draft).length > 0;

  async function saveSettings() {
    setSavingSettings(true); setError('');
    try { await api.updateSettings(draft); setDraft({}); await load(); }
    catch (err) { setError(err.message); } finally { setSavingSettings(false); }
  }

  async function removeRule(rule) {
    if (!confirm(`Delete notification rule "${rule.name || rule.channel}"?`)) return;
    try { await api.deleteNotificationRule(rule.id); await load(); }
    catch (err) { setError(err.message); }
  }

  async function testRule(rule) {
    setTestMsg(''); setError('');
    try {
      const { result } = await api.testNotification({ channel: rule.channel, target: rule.target });
      setTestMsg(result.status === 'sent' ? `Test sent via ${rule.channel} → ${result.target}` : `Test ${result.status}: ${result.error || 'no recipient'}`);
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div className="page-header"><h1>Settings</h1></div>
      {error && <div className="error">{error}</div>}

      {readiness.some((c) => !c.ok) && (
        <div className="settings-section">
          {readiness.filter((c) => !c.ok).map((c) => (
            <div key={c.key} className={`health-alert ${c.level === 'critical' ? 'health-alert-danger' : 'health-alert-warning'}`}>{c.message}</div>
          ))}
        </div>
      )}

      {/* ── Notifications ── */}
      <div className="settings-section">
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h3>Notifications</h3>
          <button onClick={() => setEditRule({})}>Add rule</button>
        </div>
        <p className="hint">Rules decide which events go where. With no rules, Astrodock emails the configured alert address for health &amp; deploy events at warning+ severity.</p>
        {testMsg && <div className="secret-banner" style={{ marginTop: 8 }}><span>{testMsg}</span></div>}
        {rules.length === 0 ? (
          <p className="empty-state">No rules.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Channel</th><th>Target</th><th>Events</th><th>Min sev.</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rules.map((rule, i) => (
                <tr key={rule.id || `implicit-${i}`}>
                  <td><strong>{rule.name || '—'}</strong>{rule.implicit && <span className="pill" style={{ marginLeft: 6 }}>default</span>}</td>
                  <td>{rule.channel}</td>
                  <td><code>{rule.channel === 'email' ? rule.target?.to : rule.target?.url}</code></td>
                  <td>{(rule.categories && rule.categories.length) ? rule.categories.join(', ') : 'all'}</td>
                  <td>{rule.minSeverity}</td>
                  <td>{rule.implicit ? 'active' : (rule.enabled ? 'enabled' : 'disabled')}</td>
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
      </div>

      {/* ── Operational settings ── */}
      <div className="settings-section">
        <h3>Operational</h3>
        <p className="hint">Defaults come from the environment; changes here override them at runtime.</p>
        {settings.map((s) => (
          <div className="settings-row" key={s.key}>
            <strong>{s.label}</strong>
            {s.type === 'enum' ? (
              <select value={valueOf(s.key)} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}>
                {s.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input
                type={s.type === 'int' ? 'number' : 'text'}
                value={valueOf(s.key) ?? ''}
                onChange={(e) => setDraft({ ...draft, [s.key]: s.type === 'int' ? Number(e.target.value) : e.target.value })}
              />
            )}
            <code>{s.source}</code>
          </div>
        ))}
        {dirty && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving…' : 'Save changes'}</button>
            <button type="button" onClick={() => setDraft({})}>Discard</button>
          </div>
        )}
      </div>

      {/* ── Backups ── */}
      {backups && (
        <div className="settings-section">
          <div className="page-header" style={{ marginBottom: 8 }}>
            <h3>Backups</h3>
            <button onClick={triggerBackup} disabled={backingUp}>{backingUp ? 'Backing up…' : 'Back up now'}</button>
          </div>
          <p className="hint">
            Scheduled pg_dumpall {backups.config.intervalHours > 0 ? `every ${backups.config.intervalHours}h` : '(disabled)'},
            keeping the last {backups.config.keep}, in <code>{backups.config.dir}</code>.
          </p>
          {(backups.backups || []).length === 0 ? (
            <p className="empty-state">No backups recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>When</th><th>Status</th><th>Size</th><th>Trigger</th></tr></thead>
              <tbody>
                {backups.backups.slice(0, 10).map((b) => (
                  <tr key={b.id}>
                    <td>{new Date(b.createdAt).toLocaleString()}</td>
                    <td><span style={{ color: b.status === 'success' ? 'var(--accent)' : 'var(--danger)' }}>{b.status}</span>{b.error && <span className="hint"> — {b.error.slice(0, 80)}</span>}</td>
                    <td>{fmtBytes(b.sizeBytes)}</td>
                    <td>{b.trigger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Diagnostics (read-only) ── */}
      {diagnostics && (
        <div className="settings-section">
          <h3>Diagnostics</h3>
          <p className="hint">Effective infra config (env-only; secrets masked).</p>
          {Object.entries(diagnostics).map(([k, v]) => (
            <div className="settings-row" key={k}>
              <strong>{k}</strong>
              <code>{typeof v === 'object' && v !== null ? Object.entries(v).map(([kk, vv]) => `${kk}: ${vv}`).join('  ·  ') : String(v)}</code>
            </div>
          ))}
        </div>
      )}

      {editRule && <RuleModal initial={editRule} onClose={() => setEditRule(null)} onSaved={() => { setEditRule(null); load(); }} />}
    </div>
  );
}
