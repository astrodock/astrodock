import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';

export default function UserDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [apps, setApps] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Editable fields
  const [name, setName] = useState('');
  const [operatorRole, setOperatorRole] = useState('');
  const [saving, setSaving] = useState(false);

  // Password reset
  const [newPassword, setNewPassword] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);

  async function load() {
    try {
      const [userData, appData] = await Promise.all([
        api.getUser(id),
        api.getApps()
      ]);
      setUser(userData.user);
      setName(userData.user.name);
      setOperatorRole(userData.user.operatorRole || '');
      setApps(appData.apps);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.updateUser(id, { name, operatorRole: operatorRole || null });
      setSuccess('User updated');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    const action = user.isActive ? 'deactivate' : 'activate';
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${user.email}?`)) return;
    setError('');
    try {
      await api.updateUser(id, { isActive: !user.isActive });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    if (!confirm(`Permanently delete ${user.email}? This cannot be undone.`)) return;
    try {
      await api.deleteUser(id);
      navigate('/users');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setError('');
    setResetSuccess(false);
    try {
      await api.resetPassword(id, newPassword);
      setNewPassword('');
      setResetSuccess(true);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleToggleAccess(appSlug, hasAccess) {
    setError('');
    try {
      if (hasAccess) {
        await api.revokeAccess(id, appSlug);
      } else {
        await api.grantAccess(id, appSlug);
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!user) return <p style={{ color: 'var(--text-muted)' }}>Loading...</p>;

  return (
    <div>
      <div className="detail-header">
        <Link to="/users" className="back-link">Users</Link>
        <span className="back-sep">/</span>
        <h1>{user.name}</h1>
        <div className="detail-meta">
          <code>{user.email}</code>
          <span className={`badge ${user.isActive ? 'active' : 'inactive'}`}>
            {user.isActive ? 'Active' : 'Inactive'}
          </span>
          {user.operatorRole && <span className="chip ok">{user.operatorRole}</span>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Profile */}
      <section className="settings-section">
        <h3>Profile</h3>
        <form onSubmit={handleSave} className="user-form">
          <div className="form-row">
            <label>
              Name
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input value={user.email} disabled />
            </label>
          </div>
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
                <button type="button" key={label} className={(operatorRole || '') === v ? 'sel' : ''}
                  onClick={() => setOperatorRole(v)}>{label}</button>
              ))}
          </div>
        </div>
          <div>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </section>

      {/* App Access */}
      <section className="settings-section">
        <h3>App Access</h3>
        {apps.length === 0 ? (
          <p className="text-muted">No apps registered yet.</p>
        ) : (
          <div className="access-grid">
            {apps.map(app => {
              const hasAccess = user.appAccess.includes(app.slug);
              return (
                <div
                  key={app.slug}
                  className={`access-card ${hasAccess ? 'granted' : ''}`}
                  onClick={() => handleToggleAccess(app.slug, hasAccess)}
                >
                  <div className="access-card-header">
                    <span className="access-card-name">{app.name}</span>
                    <div className={`access-toggle ${hasAccess ? 'on' : ''}`}>
                      <div className="access-toggle-knob" />
                    </div>
                  </div>
                  <code className="access-card-slug">{app.slug}</code>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Reset Password */}
      <section className="settings-section">
        <h3>Reset Password</h3>
        <form onSubmit={handleResetPassword} className="reset-pw-form">
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="New password (minimum 8 characters)"
            minLength={8}
            required
          />
          <button type="submit" disabled={newPassword.length < 8}>Reset Password</button>
        </form>
        {resetSuccess && (
          <p className="text-success">Password updated successfully.</p>
        )}
      </section>

      {/* Danger Zone */}
      <section className="settings-section danger-zone">
        <h3>Danger Zone</h3>
        <div className="danger-actions">
          <div className="danger-action">
            <div>
              <strong>{user.isActive ? 'Deactivate' : 'Activate'} user</strong>
              <p>{user.isActive
                ? 'User will no longer be able to log in to any apps.'
                : 'Re-enable login access for this user.'
              }</p>
            </div>
            <button onClick={handleToggleActive}>
              {user.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
          <div className="danger-action">
            <div>
              <strong>Delete user</strong>
              <p>Permanently remove this user and all their access. This cannot be undone.</p>
            </div>
            <button className="danger" onClick={handleDelete}>Delete User</button>
          </div>
        </div>
      </section>
    </div>
  );
}
