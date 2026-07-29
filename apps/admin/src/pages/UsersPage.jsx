import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import UserCreateModal from '../components/UserCreateModal';

// Roles are not interchangeable, so they should not all look alike: an owner
// can hand the platform away, a viewer can only read.
const ROLE_TONE = { owner: 'crit', admin: 'warn', operator: 'ok', viewer: '' };

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const data = await api.getUsers();
      setUsers(data.users);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>
        <p className="page-sub">People who can sign in — to the apps you grant them, and to this dashboard if you give them a role.</p>
        <button onClick={() => setShowCreate(true)}>Add User</button>
      </div>

      {error && <div className="error">{error}</div>}

      {users.length === 0 ? (
        <EmptyState icon="users" title="No People Yet"
          body="People here can sign in to the apps you grant them. Give someone a dashboard role and they can open this dashboard too."
          action={<button onClick={() => setShowCreate(true)}>Add User</button>} />
      ) : (
      <table className="data-table clickable">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Status</th>
            <th>Role</th>
            <th>App Access</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr
              key={user.id}
              className={!user.isActive ? 'inactive' : ''}
              onClick={() => navigate(`/users/${user.id}`)}
            >
              <td><strong>{user.name}</strong></td>
              <td>{user.email}</td>
              <td>
                <span className={`badge ${user.isActive ? 'active' : 'inactive'}`}>
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td>
                {user.operatorRole
                  ? <span className={`chip ${ROLE_TONE[user.operatorRole] || ''}`}>{user.operatorRole}</span>
                  : <span className="chip">app user</span>}
              </td>
              <td>
                <div className="access-pills">
                  {user.appAccess.length === 0 && (
                    <span className="text-muted">No apps</span>
                  )}
                  {user.appAccess.map(slug => (
                    <span key={slug} className="pill">{slug}</span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      {showCreate && (
        <UserCreateModal
          onClose={() => setShowCreate(false)}
          onSave={load}
        />
      )}
    </div>
  );
}
