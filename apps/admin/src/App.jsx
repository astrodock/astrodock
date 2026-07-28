import { Routes, Route, Navigate, NavLink, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getToken, clearToken, getSetupStatus, exchangeHandoff, setToken } from './lib/api';
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
import AccountPage from './pages/AccountPage';
import './App.css';

export default function App() {
  const [isAuthed, setIsAuthed] = useState(!!getToken());
  // index.html always stamps data-theme before paint; 'light' here only matters if
  // that somehow did not run, and must match the default it uses.
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  // null = still asking. Until we know, render nothing rather than flashing the
  // login form at an operator who has not created an account yet.
  const [setup, setSetup] = useState(null);
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
          <li>
            <NavLink to="/users" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 13.6c0-2.5 2.3-4.2 5.2-4.2s5.2 1.7 5.2 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Users
            </NavLink>
          </li>
          <li className="nav-sec">Network &amp; Access</li>
          <li>
            <NavLink to="/domains" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4"/><path d="M2 8h12M8 2c1.7 2 1.7 10 0 12M8 2c-1.7 2-1.7 10 0 12" stroke="currentColor" strokeWidth="1.2"/></svg>
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
          <li>
            <NavLink to="/account" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.9 3.2 3.9v3.5c0 3 2 5.7 4.8 6.7 2.8-1 4.8-3.7 4.8-6.7V3.9L8 1.9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="m5.9 7.9 1.5 1.5 2.9-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Your account
            </NavLink>
          </li>
          <li>
            <NavLink to="/settings" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Settings
            </NavLink>
          </li>
        </ul>
        <div className="sidebar-footer">
          <div className="sys-chip">
            <span className="process-dot active" />
            <div className="t"><b>System nominal</b><span>{setup?.baseDomain || 'localhost'}</span></div>
          </div>
          <div className="sidebar-actions">
            <button className="theme-toggle" onClick={toggleTheme} title="Toggle light / dark">
              {theme === 'dark' ? (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.5"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M13.5 9.3A5.6 5.6 0 0 1 6.7 2.5 5.6 5.6 0 1 0 13.5 9.3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
              )}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <button className="logout-btn" onClick={handleLogout}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M11 11l3-3-3-3M6 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Log out
            </button>
          </div>
          {/* Which Astrodock is this? Previously unanswerable without SSHing in
              and reading `docker images`. Links to Settings, where the update
              check and the build detail live. */}
          <Link className="version-line" to="/settings" title="Version and updates">
            {setup?.version ? `v${String(setup.version).replace(/^v/, '')}` : 'version unknown'}
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
          <Route path="/account" element={<AccountPage />} />
          {/* Reachable after setup so a deferred domain can still be finished. */}
          <Route path="/setup" element={<SetupPage status={setup} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
