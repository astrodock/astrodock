import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import Select from '../components/Select';

const RESULT_OPTS = [
  { value: '', label: 'All results' },
  { value: 'SUCCESS', label: 'Success' },
  { value: 'BAD_PASSWORD', label: 'Wrong password' },
  { value: 'USER_NOT_FOUND', label: 'No such account' },
  { value: 'INACTIVE_USER', label: 'Account deactivated' },
  { value: 'NO_ACCESS', label: 'No access to that app' },
  { value: 'INVALID_APP_SECRET', label: 'Bad app secret' },
  { value: 'PASSWORD_CHANGED', label: 'Password changed' },
  { value: 'PASSWORD_CHANGE_BAD_PASSWORD', label: 'Password change refused' }
];
const CATEGORY_OPTS = [
  { value: '', label: 'All categories' },
  { value: 'health', label: 'Health' },
  { value: 'deploy', label: 'Deploys' },
  { value: 'pages', label: 'Pages' },
  { value: 'auth', label: 'Sign-in' },
  { value: 'audit', label: 'Admin actions' },
  { value: 'system', label: 'System' }
];

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
  const [q, setQ] = useState('');
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
    setQ('');
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

  // One box per tab, matching across whichever fields that tab actually shows.
  const hay = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();
  const needle = q.trim().toLowerCase();
  const matches = (s) => !needle || s.includes(needle);
  const matchedEvents = events.filter((ev) =>
    matches(hay(ev.type, ev.message, ev.appSlug, ev.actor, ev.severity)));
  const matchedDeploys = deployments.filter((d) =>
    matches(hay(d.appSlug, d.status, d.commitMessage, d.commitSha, d.trigger, d.branch)));

  return (
    <div>
      <PageHeader
        title="Activity"
        description="The record of what happened — deploys, sign-ins, and every administrative change."
      />

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
            <Select value={filter.result} onChange={v => setFilter({ ...filter, result: v })}
              placeholder="All results" options={RESULT_OPTS} />
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
            <Select value={eventCategory} onChange={setEventCategory}
              placeholder="All categories" options={CATEGORY_OPTS} />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search events, apps, people…" />
          </div>
          {events.length === 0 ? (
            <EmptyState icon="activity" title="Nothing Recorded Yet"
              body="Deploys, administrative changes and platform events appear here as they happen." />
          ) : (
            matchedEvents.length === 0 ? (
              <EmptyState icon="search" title="No Matches"
                body={`Nothing in the audit trail matches “${q}”.`} />
            ) : (
            <div className="activity-list">
              {matchedEvents.map(ev => (
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
          ))}
        </div>
      )}

      {tab === 'deploys' && (
        <div>
          <div className="activity-filters">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps, commits, messages…" />
          </div>
          {deployments.length === 0 ? (
            <EmptyState icon="deploy" title="No Deployments Yet"
              body="Every build and release across your apps is listed here as it happens." />
          ) : (
            matchedDeploys.length === 0 ? (
              <EmptyState icon="search" title="No Matches"
                body={`No deployment matches “${q}”.`} />
            ) : (
            <div className="activity-list">
              {matchedDeploys.map(d => {
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
          ))}
        </div>
      )}
    </div>
  );
}
