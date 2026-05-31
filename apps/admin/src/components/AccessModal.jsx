import { useState } from 'react';
import * as api from '../lib/api';

export default function AccessModal({ user, apps, onClose, onSave }) {
  const [error, setError] = useState('');

  async function handleToggle(appSlug, hasAccess) {
    setError('');
    try {
      if (hasAccess) {
        await api.revokeAccess(user._id, appSlug);
      } else {
        await api.grantAccess(user._id, appSlug);
      }
      onSave();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>App Access for {user.name}</h2>
        <p className="subtitle">{user.email}</p>
        {error && <div className="error">{error}</div>}

        {apps.length === 0 ? (
          <p>No apps registered yet.</p>
        ) : (
          <ul className="access-list">
            {apps.map(app => {
              const hasAccess = user.appAccess.includes(app.slug);
              return (
                <li key={app.slug}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={hasAccess}
                      onChange={() => handleToggle(app.slug, hasAccess)}
                    />
                    <span>
                      <strong>{app.name}</strong>
                      <code>{app.slug}</code>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
