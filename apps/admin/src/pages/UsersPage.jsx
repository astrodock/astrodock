import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import UserCreateModal from '../components/UserCreateModal';
import PageHeader from '../components/PageHeader';
import { SkeletonRows } from '../components/Loading';

// Roles are not interchangeable, so they should not all look alike: an owner
// can hand the platform away, a viewer can only read.
// Not danger colours: an owner is the most senior role, not the most dangerous
// thing on the page. Red is reserved for destructive things and failures.
const ROLE_TONE = { owner: 'role-owner', admin: 'role-admin', operator: 'role-operator', viewer: 'role-viewer' };

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
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
    setLoaded(true);
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <PageHeader
        title="Users"
        description="People who can sign in — to the apps you grant them, and to this dashboard if you give them a role."
        action={<button onClick={() => setShowCreate(true)}>Add User</button>}
      />

      {error && <div className="error">{error}</div>}

      {!loaded ? <SkeletonRows rows={4} cols={5} /> : users.length === 0 ? (
        <EmptyState icon="users" title="No people yet"
          body="Add someone to give them access to your apps."
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
