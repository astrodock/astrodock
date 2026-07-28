import { useState } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';

export default function AccessModal({ user, apps, onClose, onSave }) {
  const [error, setError] = useState('');

  async function handleToggle(appSlug, hasAccess) {
    setError('');
    try {
      if (hasAccess) {
        await api.revokeAccess(user.id, appSlug);
      } else {
        await api.grantAccess(user.id, appSlug);
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
          <EmptyState icon="apps" title="No Apps Yet"
            body="Register an app and you can grant access to it here." />
        ) : (
          <div className="opt-list">
            {apps.map(app => {
              const hasAccess = user.appAccess.includes(app.slug);
              return (
                <div className={`opt-row ${hasAccess ? 'on' : ''}`} key={app.slug}>
                  <span className="name"><strong>{app.name}</strong><code>{app.slug}</code></span>
                  <span
                    className={`mini-toggle ${hasAccess ? 'on' : ''}`}
                    role="switch"
                    aria-checked={hasAccess}
                    aria-label={`Access to ${app.name}`}
                    onClick={() => handleToggle(app.slug, hasAccess)}
                  />
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
