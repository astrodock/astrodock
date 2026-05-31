import { useState, useEffect } from 'react';
import * as api from '../lib/api';

export default function EnvVarsTab({ app }) {
  const [envVars, setEnvVars] = useState([]);
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
      setEnvVars(data.envVars);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [app.slug]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newKey || !newValue) return;
    setError('');
    try {
      await api.setEnvVar(app.slug, newKey, newValue);
      setNewKey('');
      setNewValue('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUpdate(key) {
    setError('');
    try {
      await api.setEnvVar(app.slug, key, editValue);
      setEditingKey(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(key) {
    if (!confirm(`Delete env var ${key}?`)) return;
    setError('');
    try {
      await api.deleteEnvVar(app.slug, key);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBulkImport(e) {
    e.preventDefault();
    setError('');
    setBulkResult(null);
    try {
      const data = await api.bulkImportEnv(app.slug, bulkText);
      setBulkResult(data);
      setBulkText('');
      setEnvVars(data.envVars);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="tab-header">
        <h2>Environment Variables</h2>
        <button onClick={() => setShowBulk(true)}>Import .env</button>
      </div>
      <p className="hint">System variables are set automatically and cannot be modified here. Changes take effect on next deploy.</p>

      {error && <div className="error">{error}</div>}

      <table className="data-table env-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {envVars.map(v => (
            <tr key={v.key} className={v.isSystem ? 'system-var' : ''}>
              <td><code>{v.key}</code></td>
              <td>
                {editingKey === v.key ? (
                  <div className="env-edit-row">
                    <input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      autoFocus
                    />
                    <button onClick={() => handleUpdate(v.key)}>Save</button>
                    <button onClick={() => setEditingKey(null)} className="cancel-btn">Cancel</button>
                  </div>
                ) : (
                  <code className="env-value">{v.value}</code>
                )}
              </td>
              <td className="actions">
                {v.isSystem ? (
                  <span className="system-label">System</span>
                ) : (
                  <>
                    <button onClick={() => { setEditingKey(v.key); setEditValue(v.value); }}>Edit</button>
                    <button className="danger" onClick={() => handleDelete(v.key)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="env-add-form" onSubmit={handleAdd}>
        <input
          value={newKey}
          onChange={e => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
          placeholder="KEY_NAME"
          required
        />
        <input
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          placeholder="value"
          required
        />
        <button type="submit">Add</button>
      </form>

      {showBulk && (
        <div className="modal-overlay" onClick={() => setShowBulk(false)}>
          <form className="modal bulk-modal" onClick={e => e.stopPropagation()} onSubmit={handleBulkImport}>
            <h2>Import Environment Variables</h2>
            <p className="hint">Paste the contents of a .env file. Lines starting with # are ignored. System variables will be skipped.</p>
            {bulkResult && (
              <div className="provision-banner">
                <strong>{bulkResult.added} variable{bulkResult.added !== 1 ? 's' : ''} imported{bulkResult.skipped > 0 ? `, ${bulkResult.skipped} system var${bulkResult.skipped !== 1 ? 's' : ''} skipped` : ''}</strong>
              </div>
            )}
            <textarea
              className="bulk-textarea"
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder={"DATABASE_URL=postgres://...\nREDIS_URL=redis://...\nAPI_KEY=sk_live_...\n# Comments are ignored"}
              rows={12}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" onClick={() => { setShowBulk(false); setBulkResult(null); }}>
                {bulkResult ? 'Done' : 'Cancel'}
              </button>
              <button type="submit" disabled={!bulkText.trim()}>Import</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
