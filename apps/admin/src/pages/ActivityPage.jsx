import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';

const RESULT_STYLES = {
  SUCCESS: { color: 'var(--accent)', label: 'Success' },
  BAD_PASSWORD: { color: 'var(--danger)', label: 'Bad Password' },
  USER_NOT_FOUND: { color: 'var(--danger)', label: 'User Not Found' },
  INACTIVE_USER: { color: 'var(--warning)', label: 'Inactive User' },
  NO_ACCESS: { color: 'var(--warning)', label: 'No Access' },
  INVALID_APP_SECRET: { color: 'var(--danger)', label: 'Invalid App Secret' },
  PASSWORD_CHANGED: { color: 'var(--accent)', label: 'Password Changed' },
  PASSWORD_CHANGE_BAD_PASSWORD: { color: 'var(--danger)', label: 'Password Change Failed' }
};

const DEPLOY_STYLES = {
  success: { color: 'var(--accent)', label: 'Success' },
  failed: { color: 'var(--danger)', label: 'Failed' },
  pending: { color: 'var(--text-3)', label: 'Pending' },
  cloning: { color: 'var(--info)', label: 'Cloning' },
  building: { color: 'var(--info)', label: 'Building' },
  deploying: { color: 'var(--info)', label: 'Deploying' }
};

const SEVERITY_COLOR = { info: 'var(--text-3)', warning: 'var(--warning)', critical: 'var(--danger)' };

export default function ActivityPage() {
  const [tab, setTab] = useState('auth');
  const [authLogs, setAuthLogs] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [events, setEvents] = useState([]);
  const [eventCategory, setEventCategory] = useState('');
  const [filter, setFilter] = useState({ result: '', appId: '', email: '' });
  const [error, setError] = useState('');

  async function loadAuth() {
    try {
      const data = await api.getAuthLogs({ limit: 100, ...filter });
      setAuthLogs(data.logs);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadDeploys() {
    try {
      const data = await api.getRecentDeployments(50);
      setDeployments(data.deployments);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadEvents() {
    try {
      const data = await api.getEvents({ limit: 200, category: eventCategory || undefined });
      setEvents(data.events);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (tab === 'auth') loadAuth();
    else if (tab === 'deploys') loadDeploys();
    else loadEvents();
  }, [tab]);

  useEffect(() => {
    if (tab === 'audit') loadEvents();
  }, [eventCategory]);

  useEffect(() => {
    if (tab === 'auth') loadAuth();
  }, [filter]);

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Activity</h1>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'auth' ? 'active' : ''}`} onClick={() => setTab('auth')}>
          Auth Logs
        </button>
        <button className={`tab ${tab === 'deploys' ? 'active' : ''}`} onClick={() => setTab('deploys')}>
          Deployments
        </button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {tab === 'auth' && (
        <div>
          <div className="activity-filters">
            <select value={filter.result} onChange={e => setFilter({ ...filter, result: e.target.value })}>
              <option value="">All results</option>
              <option value="SUCCESS">Success</option>
              <option value="BAD_PASSWORD">Bad Password</option>
              <option value="USER_NOT_FOUND">User Not Found</option>
              <option value="INACTIVE_USER">Inactive User</option>
              <option value="NO_ACCESS">No Access</option>
              <option value="INVALID_APP_SECRET">Invalid App Secret</option>
              <option value="PASSWORD_CHANGED">Password Changed</option>
              <option value="PASSWORD_CHANGE_BAD_PASSWORD">Password Change Failed</option>
            </select>
            <input
              placeholder="Filter by email..."
              value={filter.email}
              onChange={e => setFilter({ ...filter, email: e.target.value })}
            />
            <input
              placeholder="Filter by app..."
              value={filter.appId}
              onChange={e => setFilter({ ...filter, appId: e.target.value })}
            />
          </div>

          {authLogs.length === 0 ? (
            <EmptyState icon="users" title="No Sign-Ins Yet"
              body="When someone signs in to one of your apps, the attempt is recorded here." />
          ) : (
            <div className="activity-list">
              {authLogs.map(log => {
                const style = RESULT_STYLES[log.result] || {};
                return (
                  <div key={log.id} className="activity-row">
                    <span className="activity-result" style={{ color: style.color }}>
                      {style.label || log.result}
                    </span>
                    <span className="activity-detail">
                      <strong>{log.email}</strong>
                      <span className="activity-sep">on</span>
                      <code>{log.appId}</code>
                    </span>
                    <span className="activity-meta">
                      <span className="activity-ip">{log.ip}</span>
                      <span>{formatTime(log.createdAt)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div>
          <div className="activity-filters">
            <select value={eventCategory} onChange={e => setEventCategory(e.target.value)}>
              <option value="">All categories</option>
              {['health', 'deploy', 'pages', 'auth', 'audit', 'system'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          {events.length === 0 ? (
            <EmptyState icon="activity" title="Nothing Recorded Yet"
              body="Deploys, administrative changes and platform events appear here as they happen." />
          ) : (
            <div className="activity-list">
              {events.map(ev => (
                <div key={ev.id} className="activity-row">
                  <span className="activity-result" style={{ color: SEVERITY_COLOR[ev.severity] || 'var(--text-3)' }}>
                    {ev.type}
                  </span>
                  <span className="activity-detail">
                    <span className="activity-commit-msg">{ev.message}</span>
                    {ev.appSlug && (<><span className="activity-sep">&middot;</span><code>{ev.appSlug}</code></>)}
                  </span>
                  <span className="activity-meta">
                    <span className="deploy-trigger">{ev.actor}</span>
                    <span>{formatTime(ev.createdAt)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'deploys' && (
        <div>
          {deployments.length === 0 ? (
            <EmptyState icon="deploy" title="No Deployments Yet"
              body="Every build and release across your apps is listed here as it happens." />
          ) : (
            <div className="activity-list">
              {deployments.map(d => {
                const style = DEPLOY_STYLES[d.status] || {};
                return (
                  <div key={d.id} className="activity-row">
                    <span className="activity-result" style={{ color: style.color }}>
                      {style.label || d.status}
                    </span>
                    <span className="activity-detail">
                      <Link to={`/apps/${d.appSlug}`}><strong>{d.appSlug}</strong></Link>
                      {d.commitHash && (
                        <>
                          <span className="activity-sep">&middot;</span>
                          <code>{d.commitHash}</code>
                        </>
                      )}
                      {d.commitMessage && (
                        <span className="activity-commit-msg">{d.commitMessage}</span>
                      )}
                    </span>
                    <span className="activity-meta">
                      <span className="deploy-trigger">{d.trigger}</span>
                      <span>{formatTime(d.startedAt)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
