import { useState } from 'react';
import * as api from '../lib/api';

export default function UserCreateModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.createUser(form);
      onSave();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>Add User</h2>
        {error && <div className="error">{error}</div>}
        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            required
            autoFocus
            placeholder="user@seniorverse.dev"
          />
        </label>
        <label>
          Name
          <input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            required
            placeholder="Full name"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            placeholder="Minimum 8 characters"
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </div>
      </form>
    </div>
  );
}
