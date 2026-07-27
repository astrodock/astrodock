import { useState } from 'react';
import * as api from '../lib/api';

export default function UserModal({ user, onClose, onSave }) {
  const isEdit = !!user;
  const [form, setForm] = useState({
    name: user?.name || '',
    email: user?.email || '',
    password: '',
    // '' means "not an operator" — an end user who can sign into apps but has no
    // dashboard access. The two are independent, which is why this is a role and
    // not a checkbox.
    operatorRole: user?.operatorRole || ''
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
        await api.updateUser(user.id, { name: form.name, operatorRole: form.operatorRole || null });
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
      await api.resetPassword(user.id, resetPw);
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

        <div className="field" style={{ display: 'block', padding: '14px 0' }}>
          <div className="lab" style={{ marginBottom: 8 }}>
            <b>Dashboard access</b>
            <span className="desc">
              Separate from which apps they can sign in to. "App user" means they can use apps you
              grant them, but cannot open this dashboard.
            </span>
          </div>
          <div className="seg">
            {[['', 'App user'], ['viewer', 'Viewer'], ['operator', 'Operator'], ['admin', 'Admin'], ['owner', 'Owner']]
              .map(([v, label]) => (
                <button type="button" key={label} className={(form.operatorRole || '') === v ? 'sel' : ''}
                  onClick={() => setForm({ ...form, operatorRole: v })}>{label}</button>
              ))}
          </div>
        </div>

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
