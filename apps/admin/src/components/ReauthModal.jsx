import { useState } from 'react';
import * as api from '../lib/api';

// Step-up authentication.
//
// Says WHY it is asking. A bare password box appearing mid-task reads like a bug
// or a phish; the point is that this action is sensitive, not that the session
// expired — and the difference matters to whoever is looking at it.

export default function ReauthModal({ action, onConfirm, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.reauth({ password });
      onConfirm();
    } catch (err) {
      // A wrong password is a 401 here. api.js knows not to treat that as a dead
      // session, so this shows an error instead of signing the operator out.
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal" onSubmit={submit}>
        <h2>Confirm It's You</h2>

        <div className="reauth-why">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3.2 5 6.2v5.1c0 4.2 3 7.9 7 9.1 4-1.2 7-4.9 7-9.1V6.2l-7-3z"
              stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 8.6v4.2M12 15.8h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span>
            {action
              ? <><b>{action}</b> changes how this account is secured, so Astrodock asks you to prove it is you — even though you are already signed in.</>
              : <>This action changes how the account is secured, so Astrodock asks you to prove it is you — even though you are already signed in.</>}
            {' '}It keeps someone who finds an unlocked screen from taking the account over.
          </span>
        </div>

        {error && <div className="error">{error}</div>}

        <label>
          Your Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="Enter your password"
          />
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  );
}
