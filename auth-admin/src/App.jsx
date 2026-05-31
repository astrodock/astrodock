import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getToken, clearToken } from './lib/api';
import LoginPage from './pages/LoginPage';
import UsersPage from './pages/UsersPage';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import UserDetailPage from './pages/UserDetailPage';
import ActivityPage from './pages/ActivityPage';
import HealthPage from './pages/HealthPage';
import './App.css';

export default function App() {
  const [isAuthed, setIsAuthed] = useState(!!getToken());
  const navigate = useNavigate();

  useEffect(() => {
    if (!getToken() && window.location.pathname !== '/login') {
      navigate('/login');
    }
  }, [navigate]);

  function handleLogin() {
    setIsAuthed(true);
    navigate('/apps');
  }

  function handleLogout() {
    clearToken();
    setIsAuthed(false);
    navigate('/login');
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
          <div className="logo-mark">SV</div>
          <span className="logo-text">Platform</span>
        </div>
        <ul className="nav-links">
          <li>
            <NavLink to="/apps" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/></svg>
              Apps
            </NavLink>
          </li>
          <li>
            <NavLink to="/users" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Users
            </NavLink>
          </li>
          <li>
            <NavLink to="/activity" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8h2l2-4 4 8 2-4h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Activity
            </NavLink>
          </li>
          <li>
            <NavLink to="/health" className={({ isActive }) => isActive ? 'active' : ''}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 14s-5.5-3.5-5.5-7.5a3.5 3.5 0 0 1 7 0 3.5 3.5 0 0 1 7 0C16.5 10.5 8 14 8 14z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Health
            </NavLink>
          </li>
        </ul>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M11 11l3-3-3-3M6 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Log out
          </button>
        </div>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/:id" element={<UserDetailPage />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:slug" element={<AppDetailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<Navigate to="/apps" />} />
        </Routes>
      </main>
    </div>
  );
}
