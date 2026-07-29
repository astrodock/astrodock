import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import * as webauthn from '../lib/webauthn';

// Step-up authentication.
//
// Says WHY it is asking — a bare password box appearing mid-task reads like a bug
// or a phish — and offers whatever the account can actually prove itself with.
//
// It used to demand a password, full stop. Anyone who had gone passkey-only had
// no answer to give, and the server would not have accepted one anyway: /reauth
// took a password or a TOTP code and nothing else. So the prompt asked, took the
// input, and asked again.

const METHODS = {
  passkey: { label: 'Passkey', blurb: 'Use Touch ID, Windows Hello, or your security key.' },
  password: { label: 'Password', blurb: null },
  totp: { label: 'Authenticator', blurb: 'Enter the current 6-digit code from your authenticator app.' },
  recoveryCode: { label: 'Recovery Code', blurb: 'Uses one of your saved recovery codes. Each works once.' }
};
// Strongest and least annoying first — a passkey is one touch.
const ORDER = ['passkey', 'password', 'totp', 'recoveryCode'];

export default function ReauthModal({ action, onConfirm, onCancel }) {
  const [options, setOptions] = useState(null);
  const [method, setMethod] = useState(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    api.reauthOptions().then((o) => {
      setOptions(o);
      const usable = ORDER.filter((m) => o[m] && (m !== 'passkey' || webauthn.supported()));
      setMethod(usable[0] || null);
    }).catch((e) => setError(e.message));
  }, []);

  async function submit(e) {
    e?.preventDefault();
    setError(''); setBusy(true);
    try {
      if (method === 'passkey') {
        const opts = await api.reauthPasskeyOptions();
        await api.reauth({ passkeyResponse: await webauthn.authenticate(opts) });
      } else {
        await api.reauth({ [method]: value });
      }
      onConfirm();
    } catch (err) {
      // A sign-in from before session tracking has nowhere to record that this
      // happened, so retrying would loop. Say so and offer the only real fix.
      if (err.body?.code === 'session_required') setStale(true);
      else if (err.name === 'NotAllowedError') setError('That was cancelled, or timed out.');
      else setError(err.message);
      setBusy(false);
    }
  }

  const usable = options ? ORDER.filter((m) => options[m] && (m !== 'passkey' || webauthn.supported())) : [];

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal" onSubmit={submit} noValidate>
        <h2>Confirm It's You</h2>

        <div className="reauth-why">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3.2 5 6.2v5.1c0 4.2 3 7.9 7 9.1 4-1.2 7-4.9 7-9.1V6.2l-7-3z"
              stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 8.6v4.2M12 15.8h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span>
            {action
              ? <><b>{action}</b> is a sensitive action, so Astrodock asks you to prove it is you — even though you are already signed in.</>
              : <>This is a sensitive action, so Astrodock asks you to prove it is you — even though you are already signed in.</>}
            {' '}It keeps someone who finds an unlocked screen from taking the account over.
          </span>
        </div>

        {stale ? (
          <>
            <div className="error">
              This sign-in predates session tracking, so it cannot confirm sensitive actions.
              Signing out and back in fixes it for good.
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="button" className="primary" onClick={() => {
                api.clearToken(); window.location.href = '/login';
              }}>Sign Out and Back In</button>
            </div>
          </>
        ) : !options ? (
          <p className="hint">Checking how you can confirm…</p>
        ) : usable.length === 0 ? (
          <>
            <div className="error">
              This account has no way to confirm — no password, no passkey, no authenticator.
              Another owner or admin will need to set one up for you.
            </div>
            <div className="modal-actions"><button type="button" onClick={onCancel}>Close</button></div>
          </>
        ) : (
          <>
            {usable.length > 1 && (
              <div className="seg seg-fit" style={{ marginBottom: 14 }}>
                {usable.map((m) => (
                  <button type="button" key={m} className={method === m ? 'sel' : ''}
                    onClick={() => { setMethod(m); setValue(''); setError(''); }}>{METHODS[m].label}</button>
                ))}
              </div>
            )}

            {error && <div className="error">{error}</div>}

            {method === 'passkey' ? (
              <p className="hint" style={{ marginBottom: 16 }}>{METHODS.passkey.blurb}</p>
            ) : (
              <label className={error ? 'has-error' : ''}>
                {method === 'password' ? 'Your Password'
                  : method === 'totp' ? 'Authenticator Code' : 'Recovery Code'}
                <input
                  type={method === 'password' ? 'password' : 'text'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                  autoComplete={method === 'password' ? 'current-password' : 'one-time-code'}
                  inputMode={method === 'totp' ? 'numeric' : undefined}
                  placeholder={method === 'totp' ? '123456' : undefined}
                />
                {METHODS[method].blurb && <span className="hint">{METHODS[method].blurb}</span>}
              </label>
            )}

            <div className="modal-actions">
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="submit" disabled={busy || (method !== 'passkey' && !value)}>
                {busy ? 'Checking…' : method === 'passkey' ? 'Use Passkey' : 'Confirm'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
