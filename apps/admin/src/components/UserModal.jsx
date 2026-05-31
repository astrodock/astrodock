import { useState } from 'react';
import * as api from '../lib/api';

export default function UserModal({ user, onClose, onSave }) {
  const isEdit = !!user;
  const [form, setForm] = useState({
    name: user?.name || '',
    email: user?.email || '',
    password: '',
    isAdmin: user?.isAdmin || false
  });
  const [resetPw, setResetPw] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isEdit) {
        await api.updateUser(user._id, { name: form.name, isAdmin: form.isAdmin });
      } else {
        await api.createUser({ email: form.email, name: form.name, password: form.password });
      }
      onSave();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setError('');
    try {
      await api.resetPassword(user._id, resetPw);
      setShowReset(false);
      setResetPw('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>{isEdit ? 'Edit User' : 'Add User'}</h2>
        {error && <div className="error">{error}</div>}

        {!isEdit && (
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              required
              autoFocus
            />
          </label>
        )}

        <label>
          Name
          <input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            required
            autoFocus={isEdit}
          />
        </label>

        {!isEdit && (
          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
            />
          </label>
        )}

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.isAdmin}
            onChange={e => setForm({ ...form, isAdmin: e.target.checked })}
          />
          Admin
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={loading}>
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>

        {isEdit && (
          <div className="reset-section">
            {!showReset ? (
              <button type="button" className="link-btn" onClick={() => setShowReset(true)}>
                Reset password
              </button>
            ) : (
              <div className="reset-form">
                <input
                  type="password"
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  minLength={8}
                />
                <button type="button" onClick={handleResetPassword} disabled={resetPw.length < 8}>
                  Reset
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
