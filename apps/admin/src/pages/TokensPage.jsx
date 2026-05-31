import { useState, useEffect } from 'react';
import * as api from '../lib/api';

function formatTime(dateStr) {
  if (!dateStr) return 'never';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export default function TokensPage() {
  const [tokens, setTokens] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api.getTokens();
      setTokens(data.tokens || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    try {
      const data = await api.createToken(name.trim(), ['deploy']);
      setRevealed(data);
      setCopied(false);
      setShowCreate(false);
      setName('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id, tokenName) {
    if (!confirm(`Revoke token "${tokenName}"? Any CLI or agent using it will stop working immediately.`)) return;
    setError('');
    try {
      await api.deleteToken(id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function copyToken() {
    if (!revealed?.token) return;
    navigator.clipboard?.writeText(revealed.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div>
      <div className="page-header">
        <h1>API Tokens</h1>
        <button onClick={() => setShowCreate(true)}>Create Token</button>
      </div>

      <p className="hint">
        Scoped tokens let the <code>toolstead</code> CLI and AI agents deploy on your behalf.
        Pass a token to the CLI via the <code>TOOLSTEAD_TOKEN</code> environment variable.
        Tokens are scoped to deploy actions and <strong>cannot manage users</strong>.
      </p>

      {error && <div className="error">{error}</div>}

      {revealed && (
        <div className="secret-banner">
          <strong>New token "{revealed.name}"</strong>
          <code>{revealed.token}</code>
          <p>{revealed.note || 'Copy this now — it will not be shown again.'}</p>
          <div className="modal-actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
            <button onClick={copyToken}>{copied ? 'Copied!' : 'Copy'}</button>
            <button onClick={() => setRevealed(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="empty-state">No tokens yet. Create one to use with the CLI or an agent.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Last Used</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map(t => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong></td>
                <td>
                  <div className="access-pills">
                    {(t.scopes || []).map(s => (
                      <span key={s} className="pill">{s}</span>
                    ))}
                  </div>
                </td>
                <td>{formatTime(t.lastUsedAt)}</td>
                <td>{formatTime(t.createdAt)}</td>
                <td className="actions">
                  <button className="danger" onClick={() => handleDelete(t.id, t.name)}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleCreate}>
            <h2>Create API Token</h2>
            {error && <div className="error">{error}</div>}
            <label>
              Name
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. ci-deploy or claude-agent"
                required
                autoFocus
              />
            </label>
            <label>
              Scopes
              <input value="deploy" disabled />
            </label>
            <p className="hint">Deploy-scoped tokens can trigger deploys and read app status. They cannot manage users.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
