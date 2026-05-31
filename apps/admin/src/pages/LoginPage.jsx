import { useState } from 'react';
import { login, setToken } from '../lib/api';

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(email, password);
      setToken(data.token);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <form className="login-form" onSubmit={handleSubmit}>
        <div className="login-logo">
          <div className="logo-mark">TS</div>
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
        <button type="submit" className="login-btn" disabled={loading}>
          {loading ? 'Authenticating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
