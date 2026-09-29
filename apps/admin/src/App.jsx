import { Routes, Route, Navigate, NavLink, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getToken, clearToken, getSetupStatus, exchangeHandoff, setToken } from './lib/api';
import * as api from './lib/api';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import OverviewPage from './pages/OverviewPage';
import UsersPage from './pages/UsersPage';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import PagesPage from './pages/PagesPage';
import PageDetailPage from './pages/PageDetailPage';
import UserDetailPage from './pages/UserDetailPage';
import ActivityPage from './pages/ActivityPage';
import HealthPage from './pages/HealthPage';
import TokensPage from './pages/TokensPage';
import DomainsPage from './pages/DomainsPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';
import Footer from './components/Footer';
import AccountPage from './pages/AccountPage';
import './App.css';

// What the footer dot is allowed to claim.
//
// Read from /health/platform, which is the same cached probe the Health page
// uses: database, object store, runner, certificate. Unreachable is its own
// answer and gets a neutral dot, because "we could not ask" is not "everything
// is fine" and the previous version said fine unconditionally.
function platformState(platform) {
  if (!platform) return { tone: 'unknown', label: 'Status unknown', title: 'Could not read platform health' };
  const parts = ['database', 'objectstore', 'runner', 'cert'];
  const down = parts.filter((k) => platform[k] && platform[k].ok === false);
  if (!down.length) return { tone: 'ok', label: 'All systems normal', title: 'Database, storage, runner and certificate are all answering' };
  const names = { database: 'database', objectstore: 'storage', runner: 'runner', cert: 'certificate' };
  return {
    tone: 'bad',
    label: down.length === 1 ? `${names[down[0]]} is down` : `${down.length} systems down`,
    title: `Not answering: ${down.map((k) => names[k]).join(', ')}`
  };
}

export default function App() {
  const [isAuthed, setIsAuthed] = useState(!!getToken());
  // index.html always stamps data-theme before paint; 'light' here only matters if
  // that somehow did not run, and must match the default it uses.
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  // null = still asking. Until we know, render nothing rather than flashing the
  // login form at an operator who has not created an account yet.
  const [setup, setSetup] = useState(null);
  // Who is signed in, and whether the platform's own dependencies are answering.
  // The footer used to assert "System nominal" from a hardcoded string next to a
  // permanently green dot, which told you nothing and could not be wrong.
  const [me, setMe] = useState(null);
  const [platform, setPlatform] = useState(null);
  const navigate = useNavigate();

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('astrodock_theme', next); } catch { /* ignore */ }
  }

  useEffect(() => {
    // Arriving from the setup wizard at a brand-new origin: the fragment carries a
    // one-shot nonce to trade for a session, because sessionStorage did not follow
    // us across the hostname change. Consume it before anything else decides we are
    // logged out, and strip it from the URL either way so a reload cannot replay it.
    const m = window.location.hash.match(/(?:^|[#&])handoff=([a-f0-9]+)/);
    const finish = () => getSetupStatus().then(setSetup).catch(() => setSetup({ complete: true }));

    if (!m) { finish(); return; }

    const clearHash = () =>
      window.history.replaceState(null, '', window.location.pathname + window.location.search);

    exchangeHandoff(m[1])
      .then((data) => { setToken(data.token); setIsAuthed(true); })
      .catch(() => { /* expired or already used — the login page is the right landing */ })
      .finally(() => { clearHash(); finish(); });
  }, []);

  useEffect(() => {
    if (setup && !setup.complete) return; // the wizard owns the screen
    if (!getToken() && window.location.pathname !== '/login') {
      navigate('/login');
    }
  }, [navigate, setup]);

  // Footer data. /health/platform serves a cached probe, so polling it is cheap;
  // a failure leaves the dot neutral rather than claiming either answer.
  useEffect(() => {
    if (!isAuthed) { setMe(null); setPlatform(null); return undefined; }
    let alive = true;
    const load = () => {
      api.getAccount().then((d) => alive && setMe(d.user || d)).catch(() => {});
      api.getPlatformHealth().then((d) => alive && setPlatform(d)).catch(() => alive && setPlatform(null));
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAuthed]);

  function handleLogin() {
    setIsAuthed(true);
    navigate('/overview');
  }

  function handleLogout() {
    clearToken();
    setIsAuthed(false);
    navigate('/login');
  }

  if (setup === null) return null; // one paint, not a flash of the wrong screen

  // Unconfigured platform: the wizard takes over regardless of route or session.
  // It covers both halves of a fresh install — no administrator yet, and/or no
  // domain yet — so an operator who set ADMIN_EMAIL in .env still lands on the
  // domain step rather than a dashboard pointing at nowhere.
  if (!setup.complete) {
    return <SetupPage status={setup} />;
  }

  if (!isAuthed) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-header">
          <div className="logo-mark">
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <circle cx="17" cy="17" r="15" stroke="var(--accent)" strokeWidth="1.4" opacity=".4"/>
              <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" strokeWidth="1.4" opacity=".7"/>
              <circle cx="17" cy="17" r="3.6" fill="var(--accent)"/>
              <g className="orbit-dot"><circle cx="32" cy="17" r="2.3" fill="var(--text)"/></g>
            </svg>
          </div>
          <div className="logo-wrap">
            <span className="logo-text">ASTRO<span className="logo-text-dim">DOCK</span></span>
            <span className="logo-sub">control plane</span>
          </div>
        </div>
        <ul className="nav-links">
          <li className="nav-sec">Operate</li>
          <li>
            <NavLink to="/overview" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 8.6 8 3.2l5.5 5.4M4.2 7.6V13a.6.6 0 0 0 .6.6h6.4a.6.6 0 0 0 .6-.6V7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Overview
            </NavLink>
          </li>
          <li>
            <NavLink to="/apps" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/></svg>
              Apps
            </NavLink>
          </li>
          <li>
            <NavLink to="/pages" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.6 2h5.1l3.7 3.7v8.3H3.6V2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M8.6 2v3.8h3.8M5.8 8.8h4.4M5.8 11.2h4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Pages
            </NavLink>
          </li>
          <li className="nav-sec">Network &amp; Access</li>
          <li>
            <NavLink to="/users" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 13.6c0-2.5 2.3-4.2 5.2-4.2s5.2 1.7 5.2 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Users
            </NavLink>
          </li>
          <li>
            <NavLink to="/domains" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.8.2l2-2a2.7 2.7 0 0 0-3.8-3.8l-1 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.8-.2l-2 2a2.7 2.7 0 0 0 3.8 3.8l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Domains
            </NavLink>
          </li>
          <li>
            <NavLink to="/tokens" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="10.6" cy="5.4" r="3.1" stroke="currentColor" strokeWidth="1.4"/><path d="M8.4 7.6 2.6 13.4v1.2h2.2v-1.5h1.5v-1.5h1.4l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Access keys
            </NavLink>
          </li>
          <li className="nav-sec">Observe</li>
          <li>
            <NavLink to="/activity" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.8 8h2.4l2-4.4 3.6 9 2-4.6h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Activity
            </NavLink>
          </li>
          <li>
            <NavLink to="/health" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 13.8S2.4 10.4 2.4 6.5A2.9 2.9 0 0 1 8 5.2a2.9 2.9 0 0 1 5.6 1.3c0 3.9-5.6 7.3-5.6 7.3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
              Health
            </NavLink>
          </li>
          <li className="nav-sec">Manage</li>
          <li>
            <NavLink to="/account" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.9 3.2 3.9v3.5c0 3 2 5.7 4.8 6.7 2.8-1 4.8-3.7 4.8-6.7V3.9L8 1.9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="m5.9 7.9 1.5 1.5 2.9-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Your account
            </NavLink>
          </li>
          <li>
            <NavLink to="/settings" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.6 1.9h2.8l.3 1.7 1.3.75 1.6-.63 1.4 2.42-1.3 1.1v1.5l1.3 1.1-1.4 2.42-1.6-.63-1.3.75-.3 1.7H6.6l-.3-1.7-1.3-.75-1.6.63-1.4-2.42 1.3-1.1v-1.5l-1.3-1.1 1.4-2.42 1.6.63 1.3-.75.3-1.7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3"/></svg>
              Settings
            </NavLink>
          </li>
        </ul>
        <div className="sidebar-footer">
          {/* Who you are, pinned. It was an item in the middle of the Manage
              list, which is where you look for things you administer rather than
              for yourself. Theme and sign out moved onto that page with it: they
              are settings about you, and two icon buttons down here were the only
              thing in the sidebar that was not navigation. */}
          <NavLink to="/account" className={({ isActive }) => `acct-chip${isActive ? ' active' : ''}`}>
            <span className="acct-avatar">{(me?.name || me?.email || '?').trim()[0]?.toUpperCase()}</span>
            <div className="t">
              <b>{me?.name || me?.email || 'Your account'}</b>
              <span>{me?.name && me?.email ? me.email : 'Account and security'}</span>
            </div>
          </NavLink>

          {/* One line: what state the platform is in, and which version it is.
              Both used to be separate blocks, and the state was the string
              "System nominal" beside a dot that was green in the markup. It is
              read from the platform probe now, so it can say no. */}
          <Link className={`sys-line ${platformState(platform).tone}`} to="/settings"
            title={platformState(platform).title}>
            <span className="led" />
            <span className="sys-text">{platformState(platform).label}</span>
            <span className="sys-ver">
              {setup?.version ? `v${String(setup.version).replace(/^v/, '')}` : 'version unknown'}
            </span>
          </Link>
        </div>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/:id" element={<UserDetailPage />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:slug" element={<AppDetailPage />} />
          <Route path="/pages" element={<PagesPage />} />
          <Route path="/pages/:pageId" element={<PageDetailPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/domains" element={<DomainsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage theme={theme} onToggleTheme={toggleTheme} onSignOut={handleLogout} />} />
          {/* Reachable after setup so a deferred domain can still be finished. */}
          <Route path="/setup" element={<SetupPage status={setup} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <Footer version={setup?.version} baseDomain={setup?.baseDomain} />
      </main>
    </div>
  );
}
