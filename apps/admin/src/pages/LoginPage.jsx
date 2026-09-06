import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { login, setToken } from '../lib/api';
import * as webauthn from '../lib/webauthn';

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Only revealed once the server says this account has one — asking everyone for
  // a code they may not have would be worse than one extra round trip.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeySupported = webauthn.supported();
  // Absent unless the platform has a Google client configured, rather than
  // present and failing when pressed.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleTicket, setGoogleTicket] = useState(null);

  useEffect(() => {
    api.googleEnabled().then((d) => setGoogleEnabled(!!d.enabled)).catch(() => setGoogleEnabled(false));
  }, []);

  // Coming back from Google. The callback cannot mint a session directly, because
  // the account may still owe a code, so it parks a single-use ticket and the
  // exchange happens here where the TOTP field already lives.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const err = p.get('google_error');
    const ticket = p.get('google_ticket');
    if (!err && !ticket) return;
    window.history.replaceState(null, '', '/login');
    if (err) { setError(err); return; }
    exchangeGoogle(ticket);
  }, []);

  async function exchangeGoogle(ticket, extra = {}) {
    setError(''); setLoading(true);
    try {
      const data = await api.loginGoogle(ticket, extra);
      setToken(data.token);
      onLogin();
    } catch (err) {
      if (err.body?.code === 'totp_required') {
        // Google got us this far; the second factor is still owed.
        setGoogleTicket(err.body.ticket);
        setNeedsCode(true);
        setError(extra.totp || extra.recoveryCode ? err.message : '');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  // Discoverable credentials: the authenticator knows which account it is for, so
  // there is nothing to type first. This is the whole point of a passkey and the
  // dashboard has never offered it.
  async function signInWithPasskey() {
    setError(''); setPasskeyBusy(true);
    try {
      const { handle, options } = await api.loginPasskeyOptions();
      const data = await api.loginPasskey(handle, await webauthn.authenticate(options));
      setToken(data.token);
      onLogin();
    } catch (err) {
      if (err.name === 'NotAllowedError') setError('That was cancelled, or timed out.');
      else setError(err.message);
      setPasskeyBusy(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Mid-Google sign-in the form is only collecting the second factor, and the
    // password fields are not part of it.
    if (googleTicket) {
      return exchangeGoogle(googleTicket, useRecovery ? { recoveryCode: code } : { totp: code });
    }
    setError('');
    setLoading(true);
    try {
      const extra = code ? (useRecovery ? { recoveryCode: code } : { totp: code }) : {};
      const data = await login(email, password, extra);
      setToken(data.token);
      onLogin();
    } catch (err) {
      if (err.body?.code === 'totp_required') {
        setNeedsCode(true);
        // Don't shout "wrong code" at someone who has not been asked for one yet.
        setError(code ? err.message : '');
      } else if (err.body?.code === 'mfa_enrolment_required') {
        setError(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <form className="login-form" onSubmit={handleSubmit} noValidate>
        <div className="login-logo">
          <div className="logo-mark">
            <svg width="38" height="38" viewBox="0 0 34 34" fill="none">
              <circle cx="17" cy="17" r="15" stroke="var(--accent)" strokeWidth="1.4" opacity=".4"/>
              <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" strokeWidth="1.4" opacity=".7"/>
              <circle cx="17" cy="17" r="3.6" fill="var(--accent)"/>
              <g className="orbit-dot"><circle cx="32" cy="17" r="2.3" fill="var(--text)"/></g>
            </svg>
          </div>
          <span className="logo-text-lg">Astrodock</span>
        </div>
        <p className="login-subtitle">Admin Control Plane</p>
        {error && <div className="error">{error}</div>}
        {googleTicket && (
          <p className="login-subtitle">Signed in with Google. One more step.</p>
        )}
        {!googleTicket && <label>
          Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="you@example.com"
          />
        </label>}
        {!googleTicket && <label>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            placeholder="Enter password"
          />
        </label>}
        {needsCode && (
          <label>
            {useRecovery ? 'Recovery code' : 'Authenticator code'}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
            />
            <button type="button" className="link-btn" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
              {useRecovery ? 'Use my authenticator app instead' : "I've lost my authenticator — use a recovery code"}
            </button>
          </label>
        )}
        <button type="submit" className="login-btn" disabled={loading || passkeyBusy}>
          {loading ? 'Signing in…' : googleTicket ? 'Continue' : 'Sign In'}
        </button>

        {googleEnabled && !googleTicket && (
          <>
            <div className="or-rule"><span>or</span></div>
            {/* A link, not a fetch: the whole point is leaving for Google. */}
            <a className="login-btn secondary" href="/admin/google/start">
              <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z"/>
                <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/>
                <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/>
              </svg>
              Continue with Google
            </a>
          </>
        )}

        {passkeySupported && !googleTicket && (
          <>
            <div className="or-rule"><span>or</span></div>
            <button type="button" className="login-btn secondary"
              onClick={signInWithPasskey} disabled={loading || passkeyBusy}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="6" cy="5.4" r="2.9" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3 13.6c0-2 1.4-3.4 3-3.4M10.5 8.5v5.1M9.2 10.4h2.6M9.2 12.2h2"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              {passkeyBusy ? 'Waiting for your device…' : 'Sign in with a passkey'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
