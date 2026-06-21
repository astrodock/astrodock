import { useState, useEffect } from 'react';
import * as api from '../lib/api';

export default function EnvVarsTab({ app, onRefresh }) {
  const [envVars, setEnvVars] = useState([]);
  const [missingRequired, setMissingRequired] = useState([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkResult, setBulkResult] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api.getEnvVars(app.slug);
      setEnvVars(data.envVars || []);
      setMissingRequired(data.missingRequired || []);
      onRefresh?.();
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [app.slug]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newKey || !newValue) return;
    setError('');
    try { await api.setEnvVar(app.slug, newKey, newValue); setNewKey(''); setNewValue(''); load(); }
    catch (err) { setError(err.message); }
  }
  async function handleUpdate(key) {
    setError('');
    try { await api.setEnvVar(app.slug, key, editValue); setEditingKey(null); setEditValue(''); load(); }
    catch (err) { setError(err.message); }
  }
  async function handleDelete(key) {
    if (!confirm(`Delete the variable ${key}?`)) return;
    setError('');
    try { await api.deleteEnvVar(app.slug, key); load(); } catch (err) { setError(err.message); }
  }
  async function handleBulkImport(e) {
    e.preventDefault();
    setError(''); setBulkResult(null);
    try { const data = await api.bulkImportEnv(app.slug, bulkText); setBulkResult(data); setBulkText(''); load(); }
    catch (err) { setError(err.message); }
  }
  function startEdit(v) { setEditingKey(v.key); setEditValue(v.isSecret ? '' : (v.value ?? '')); }

  function Row({ v, deletable }) {
    const masked = v.isSecret && v.isSet;
    return (
      <tr className={v.kind === 'reserved' ? 'system-var' : ''}>
        <td>
          <code>{v.key}</code>
          <div className="env-badges">
            {v.required && <span className="env-badge env-badge-required">required</span>}
            {v.isSecret && <span className="env-badge env-badge-secret">secret</span>}
            {!v.isSet && <span className="env-badge env-badge-unset">not set</span>}
          </div>
          {v.description && <span className="env-desc">{v.description}</span>}
        </td>
        <td>
          {editingKey === v.key ? (
            <div className="env-edit-row">
              <input type={v.isSecret ? 'password' : 'text'} value={editValue} onChange={(e) => setEditValue(e.target.value)} placeholder={v.isSecret ? 'Enter a new value' : 'value'} autoFocus />
              <button onClick={() => handleUpdate(v.key)}>Save</button>
              <button onClick={() => { setEditingKey(null); setEditValue(''); }} className="cancel-btn">Cancel</button>
            </div>
          ) : masked ? <code className="env-value">••••••</code>
            : v.isSet ? <code className="env-value">{v.value}</code>
              : (v.default != null && v.default !== '') ? <code className="env-value env-value-default">{v.default} <span className="env-default-tag">default</span></code>
                : <span className="text-muted">not set</span>}
        </td>
        <td className="actions">
          <button onClick={() => startEdit(v)}>{v.isSet ? (v.isSecret ? 'Replace' : 'Edit') : 'Set value'}</button>
          {deletable && <button className="danger" onClick={() => handleDelete(v.key)}>Delete</button>}
        </td>
      </tr>
    );
  }

  const yours = envVars.filter((v) => v.kind === 'declared');
  const provided = envVars.filter((v) => v.kind === 'reserved');

  return (
    <div>
      <div className="tab-header">
        <h2>Variables</h2>
        <button onClick={() => setShowBulk(true)}>Import .env</button>
      </div>
      <p className="hint">Settings and secrets your app reads while it runs — things like API keys and connection strings. Changes apply on the next deploy.</p>

      {error && <div className="error">{error}</div>}

      {missingRequired.length > 0 && (
        <div className="missing-vars-banner">
          <strong>{missingRequired.length} required variable{missingRequired.length > 1 ? 's' : ''} must be set before you can deploy</strong>
          <ul>
            {missingRequired.map((m) => (
              <li key={m.key}><code>{m.key}</code>{m.reason && <span className="missing-reason"> — {m.reason}</span>}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="set-section">
        <div className="sec-head"><div><h2>Your variables</h2><p>Ones you add yourself, or that your app declares in its <code>app.json</code>.</p></div></div>
        {yours.length === 0 ? (
          <p className="empty-state" style={{ padding: '1.5rem 0' }}>None yet — add one below.</p>
        ) : (
          <table className="data-table env-table">
            <thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
            <tbody>{yours.map((v) => <Row key={v.key} v={v} deletable />)}</tbody>
          </table>
        )}
        <form className="env-add-form" onSubmit={handleAdd}>
          <input value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} placeholder="NAME" required />
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" required />
          <button type="submit">Add</button>
        </form>
      </section>

      {provided.length > 0 && (
        <section className="set-section">
          <div className="sec-head"><div><h2>Provided by Astrodock</h2><p>Filled in automatically from your resource choices — the database connection, storage keys, your app’s secret, and so on. You don’t normally touch these. A few marked <b>not set</b> need a value from you (for example, when you bring your own database).</p></div></div>
          <table className="data-table env-table">
            <thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
            <tbody>{provided.map((v) => <Row key={v.key} v={v} deletable={false} />)}</tbody>
          </table>
        </section>
      )}

      {showBulk && (
        <div className="modal-overlay" onClick={() => setShowBulk(false)}>
          <form className="modal bulk-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleBulkImport}>
            <h2>Import variables from a .env file</h2>
            <p className="hint">Paste the contents of a <code>.env</code> file. Lines starting with <code>#</code> are ignored, and Astrodock-managed (<code>ASTRODOCK_</code>) names are skipped.</p>
            {bulkResult && <div className="provision-banner"><strong>{bulkResult.added} variable{bulkResult.added !== 1 ? 's' : ''} imported{bulkResult.skipped > 0 ? `, ${bulkResult.skipped} skipped` : ''}</strong></div>}
            <textarea className="bulk-textarea" value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=sk_live_…\n# comments are ignored'} rows={12} autoFocus />
            <div className="modal-actions">
              <button type="button" onClick={() => { setShowBulk(false); setBulkResult(null); }}>{bulkResult ? 'Done' : 'Cancel'}</button>
              <button type="submit" disabled={!bulkText.trim()}>Import</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
