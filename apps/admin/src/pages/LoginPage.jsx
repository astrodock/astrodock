import { useState } from 'react';
import { login, setToken } from '../lib/api';

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

  async function handleSubmit(e) {
    e.preventDefault();
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
      <form className="login-form" onSubmit={handleSubmit}>
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
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="you@example.com"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            placeholder="Enter password"
          />
        </label>
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
        <button type="submit" className="login-btn" disabled={loading}>
          {loading ? 'Authenticating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
