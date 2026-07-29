import { useState } from 'react';
import * as api from '../lib/api';

// Changing your password.
//
// Was a single inline box next to a Save button: type once, no confirmation, no
// current password. A typo silently became your new password, and anyone at an
// unlocked screen could change it with one click. It asks for the current one
// and for the new one twice, in a modal, like the rest of the account actions.
//
// The current-password check is on top of step-up, not instead of it — step-up
// proves you are present, this proves you knew the password you are replacing.

const MIN = 8;

export default function PasswordModal({ hasPassword, onClose, onSaved }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  const tooShort = next.length > 0 && next.length < MIN;
  const mismatch = confirm.length > 0 && next !== confirm;
  const same = hasPassword && current.length > 0 && current === next;
  const ready = next.length >= MIN && next === confirm && (!hasPassword || current.length > 0) && !same;

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await api.setPassword(next, hasPassword ? current : undefined);
      onSaved(hasPassword ? 'Password changed.' : 'Password set.');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} noValidate>
        <h2>{hasPassword ? 'Change Your Password' : 'Set a Password'}</h2>

        {error && <div className="error">{error}</div>}

        {hasPassword && (
          <label className={touched && !current ? 'has-error' : ''}>
            Current Password
            <input type="password" value={current} autoFocus autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)} />
            {touched && !current && <span className="field-error">Enter your current password.</span>}
          </label>
        )}

        <label className={tooShort || same ? 'has-error' : ''}>
          New Password
          <input type="password" value={next} autoComplete="new-password"
            autoFocus={!hasPassword}
            onChange={(e) => setNext(e.target.value)} />
          {tooShort
            ? <span className="field-error">Use at least {MIN} characters.</span>
            : same
              ? <span className="field-error">That is the password you already have.</span>
              : <span className="hint">At least {MIN} characters.</span>}
        </label>

        <label className={mismatch ? 'has-error' : ''}>
          Repeat New Password
          <input type="password" value={confirm} autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)} />
          {mismatch && <span className="field-error">These do not match.</span>}
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : hasPassword ? 'Change Password' : 'Set Password'}
          </button>
        </div>
      </form>
    </div>
  );
}
