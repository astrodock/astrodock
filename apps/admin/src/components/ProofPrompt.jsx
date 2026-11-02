import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import * as webauthn from '../lib/webauthn';

// The proof an approval asks for: a passkey, or a code from an authenticator app.
//
// Every time, not once per session. An agent driving this browser could click a
// button inside a fifteen-minute window, and a password is something an agent
// can be told. Passkey first, and recommended: a code can still be read out to
// whoever asks for it in a chat, and a passkey cannot.
//
// `onProof(proof)` does the approving and throws on failure.

export default function ProofPrompt({ actionLabel = 'Approve', onProof, disabled }) {
  const [avail, setAvail] = useState(null);
  const [mode, setMode] = useState('passkey');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.proofOptions().then((a) => {
      setAvail(a);
      setMode(a.passkey && webauthn.supported() ? 'passkey' : 'totp');
    }).catch((e) => setError(e.message));
  }, []);

  async function withPasskey() {
    setError(''); setBusy(true);
    try {
      const options = await api.proofPasskeyOptions();
      await onProof({ passkeyResponse: await webauthn.authenticate(options) });
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? 'That was cancelled, or timed out.' : e.message);
    } finally { setBusy(false); }
  }

  async function withCode(e) {
    e.preventDefault();
    if (code.trim().length < 6) return;
    setError(''); setBusy(true);
    try { await onProof({ totp: code.trim() }); }
    catch (err) { setError(err.message); setCode(''); }
    finally { setBusy(false); }
  }

  if (!avail) return error ? <div className="error">{error}</div> : <p className="hint">Checking how you can confirm…</p>;

  const passkey = avail.passkey && webauthn.supported();
  if (!passkey && !avail.totp) {
    return (
      <div className="proof">
        <p>
          Approving needs a passkey or an authenticator app, and this account has neither yet.
          Add a passkey on <Link to="/account">Your Account</Link>, then come back to this page.
        </p>
      </div>
    );
  }

  return (
    <div className="proof">
      {error && <div className="error">{error}</div>}
      {mode === 'passkey' && passkey ? (
        <>
          <button type="button" className="primary" onClick={withPasskey} disabled={busy || disabled}>
            {busy ? 'Waiting for Your Device…' : `${actionLabel} with Passkey`}
          </button>
          {avail.totp && (
            <button type="button" className="link-btn" onClick={() => { setMode('totp'); setError(''); }}>
              Use an Authenticator Code Instead
            </button>
          )}
        </>
      ) : (
        <form onSubmit={withCode} noValidate>
          <label>
            Authenticator Code
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6}
              value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <span className="hint">Type it from your phone yourself. Never give this code to anyone who asks for it, including an agent.</span>
          </label>
          <div className="proof-actions">
            <button type="submit" className="primary" disabled={busy || disabled || code.length < 6}>
              {busy ? 'Checking…' : actionLabel}
            </button>
            {passkey && (
              <button type="button" className="link-btn" onClick={() => { setMode('passkey'); setError(''); }}>
                Use a Passkey Instead
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
