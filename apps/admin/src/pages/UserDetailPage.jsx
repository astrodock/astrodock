import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import useConfirm from '../lib/useConfirm';

// Not danger colours: an owner is the most senior role, not the most dangerous
// thing on the page. Red is reserved for destructive things and failures.
const ROLE_TONE = { owner: 'role-owner', admin: 'role-admin', operator: 'role-operator', viewer: 'role-viewer' };

export default function UserDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [apps, setApps] = useState([]);
  const [error, setError] = useState('');
  const [confirmNode, ask] = useConfirm();
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

  function handleToggleActive() {
    const deactivating = user.isActive;
    ask({
      title: deactivating ? 'Deactivate this account?' : 'Reactivate this account?',
      danger: deactivating,
      confirmLabel: deactivating ? 'Deactivate' : 'Reactivate',
      body: deactivating ? (
        <>
          <p><b>{user.email}</b> will not be able to sign in to any app on this server, and
            existing sessions stop working.</p>
          <p className="hint">Nothing is deleted. Reactivating restores access exactly as it was.</p>
        </>
      ) : (
        <p><b>{user.email}</b> will be able to sign in again, with the same access they had before.</p>
      ),
      onConfirm: async () => {
        setError('');
        try {
          await api.updateUser(id, { isActive: !user.isActive });
          load();
        } catch (err) {
          setError(err.message);
        }
      }
    });
  }

  function handleDelete() {
    ask({
      title: 'Permanently delete this account?',
      danger: true,
      confirmLabel: 'Delete account',
      typeToConfirm: user.email,
      body: (
        <>
          <p><b>{user.email}</b>, their passkeys, their two-factor setup and their sign-in history
            are all removed. They lose access to every app on this server immediately.</p>
          <p className="hint">There is no undo. If you only want to block them for now,
            deactivate the account instead — that is reversible.</p>
        </>
      ),
      onConfirm: async () => {
        try {
          await api.deleteUser(id);
          navigate('/users');
        } catch (err) {
          setError(err.message);
        }
      }
    });
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

  if (!user) return <p className="text-muted">Loading…</p>;

  return (
    <>
      {confirmNode}
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
          {user.operatorRole && <span className={`chip ${ROLE_TONE[user.operatorRole] || ''}`}>{user.operatorRole}</span>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="provision-banner"><strong>{success}</strong></div>}

      {/* Profile */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Profile</h2><p>Their name, and whether they can open this dashboard at all.</p></div></div>
        <form onSubmit={handleSave} className="user-form" noValidate>
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
      <section className="set-section">
        <div className="sec-head"><div><h2>App Access</h2><p>Which of your apps this person can sign in to. Turning one on takes effect immediately.</p></div></div>
        {apps.length === 0 ? (
          <EmptyState icon="apps" title="No Apps Yet"
            body="Once you register an app, you can grant this person access to it here." />
        ) : (
          <div className="opt-list">
            {apps.map(app => {
              const hasAccess = user.appAccess.includes(app.slug);
              return (
                <div className={`opt-row ${hasAccess ? 'on' : ''}`} key={app.slug}>
                  <span className="name">{app.name}<code>{app.slug}</code></span>
                  <span
                    className={`mini-toggle ${hasAccess ? 'on' : ''}`}
                    role="switch"
                    aria-checked={hasAccess}
                    aria-label={`Access to ${app.name}`}
                    onClick={() => handleToggleAccess(app.slug, hasAccess)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Reset Password */}
      <section className="set-section">
        <div className="sec-head"><div><h2>Reset Password</h2><p>Sets a new password for them. They are not emailed — you will need to pass it on yourself.</p></div></div>
        <form onSubmit={handleResetPassword} className="reset-pw-form" noValidate>
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
      <section className="set-section danger-zone">
        <div className="sec-head"><div><h2>Danger Zone</h2><p>Deactivating blocks every sign-in, everywhere, at once.</p></div></div>
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
    </>
  );
}
