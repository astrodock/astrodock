import { useEffect, useState } from 'react';

// Same-origin API calls (Caddy routes /api/* to the server). Cookies carry the session.
const api = (path, opts = {}) =>
  fetch(`/api${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts })
    .then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));

export default function App() {
  const [user, setUser] = useState(null);
  const [welcome, setWelcome] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/me').then((r) => { if (r.ok) { setUser(r.data.user); setWelcome(r.data.welcome); } setLoading(false); });
  }, []);

  if (loading) return <Shell><p>Loading…</p></Shell>;
  if (!user) return <Shell><Login onLogin={(u, w) => { setUser(u); setWelcome(w); }} /></Shell>;
  return <Shell><Dashboard user={user} welcome={welcome} onLogout={() => setUser(null)} /></Shell>;
}

function Shell({ children }) {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '64px auto', padding: '0 20px', color: '#1a1a1a' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Toolstead Starter</h1>
      <p style={{ color: '#666', marginTop: 0 }}>A minimal app using platform login.</p>
      <div style={{ marginTop: 24 }}>{children}</div>
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    setErr('');
    const r = await api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (r.ok) { const me = await api('/me'); onLogin(me.data.user, me.data.welcome); }
    else setErr(r.data.error || 'Login failed');
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" type="email" required style={inp} />
      <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" required style={inp} />
      <button type="submit" style={btn}>Log in</button>
      {err && <p style={{ color: '#c0392b' }}>{err}</p>}
      <p style={{ color: '#888', fontSize: 13 }}>Use a user the admin granted access to this app.</p>
    </form>
  );
}

function Dashboard({ user, welcome, onLogout }) {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  useEffect(() => { api('/notes').then((r) => r.ok && setNotes(r.data.notes)); }, []);
  async function add(e) {
    e.preventDefault();
    const r = await api('/notes', { method: 'POST', body: JSON.stringify({ text }) });
    if (r.ok) { setNotes(r.data.notes); setText(''); }
  }
  async function logout() { await api('/logout', { method: 'POST' }); onLogout(); }
  return (
    <div>
      <p>{welcome}</p>
      <p>Signed in as <strong>{user.email}</strong> · <button onClick={logout} style={linkBtn}>log out</button></p>
      <h3>Notes</h3>
      <form onSubmit={add} style={{ display: 'flex', gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="a quick note" style={{ ...inp, flex: 1 }} />
        <button type="submit" style={btn}>Add</button>
      </form>
      <ul>{notes.map((n, i) => <li key={i}>{n.text} <span style={{ color: '#aaa', fontSize: 12 }}>— {n.by}</span></li>)}</ul>
    </div>
  );
}

const inp = { padding: '9px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 };
const btn = { padding: '9px 16px', background: '#1a1a1a', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer' };
const linkBtn = { background: 'none', border: 0, color: '#2563eb', cursor: 'pointer', padding: 0, textDecoration: 'underline' };
