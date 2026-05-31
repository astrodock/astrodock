import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import UserCreateModal from '../components/UserCreateModal';

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
        <button onClick={() => setShowCreate(true)}>Add User</button>
      </div>

      {error && <div className="error">{error}</div>}

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
              key={user._id}
              className={!user.isActive ? 'inactive' : ''}
              onClick={() => navigate(`/users/${user._id}`)}
            >
              <td><strong>{user.name}</strong></td>
              <td>{user.email}</td>
              <td>
                <span className={`badge ${user.isActive ? 'active' : 'inactive'}`}>
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td>{user.isAdmin ? 'Admin' : 'User'}</td>
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

      {showCreate && (
        <UserCreateModal
          onClose={() => setShowCreate(false)}
          onSave={load}
        />
      )}
    </div>
  );
}
