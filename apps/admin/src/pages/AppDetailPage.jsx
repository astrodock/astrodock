import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost, appUrl } from '../lib/appUrl';
import DeploysTab from '../components/DeploysTab';
import EnvVarsTab from '../components/EnvVarsTab';
import LogsTab from '../components/LogsTab';
import SettingsTab from '../components/SettingsTab';
import TerminalTab from '../components/TerminalTab';

const TABS = ['deploys', 'env', 'logs', 'terminal', 'settings'];

const STATUS_LABELS = {
  online: { label: 'Running', className: 'active' },
  stopped: { label: 'Stopped', className: 'inactive' },
  errored: { label: 'Errored', className: 'errored' },
  unavailable: { label: 'Unknown', className: 'inactive' }
};

function formatUptime(ms) {
  if (!ms) return '';
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function formatMemory(bytes) {
  if (!bytes) return '';
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

export default function AppDetailPage() {
  const { slug } = useParams();
  const [app, setApp] = useState(null);
  const [missingRequired, setMissingRequired] = useState([]);
  const [procStatus, setProcStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('deploys');
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api.getApp(slug);
      setApp(data.app);
      setMissingRequired(data.missingRequired || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadStatus() {
    try {
      const data = await api.getAppStatus(slug);
      setProcStatus(data);
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); loadStatus(); }, [slug]);

  // Refresh status periodically
  useEffect(() => {
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, [slug]);

  async function handleRestart() {
    try {
      await api.restartApp(slug);
      setTimeout(loadStatus, 1000);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleStop() {
    if (!confirm('Stop this app? It will no longer respond to requests.')) return;
    try {
      await api.stopApp(slug);
      setTimeout(loadStatus, 1000);
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !app) return <div className="error">{error}</div>;
  if (!app) return <p style={{ color: 'var(--text-muted)' }}>Loading...</p>;

  const statusInfo = STATUS_LABELS[procStatus?.status] || STATUS_LABELS.unavailable;

  return (
    <div>
      <div className="detail-header">
        <Link to="/apps" className="back-link">Apps</Link>
        <span className="back-sep">/</span>
        <h1>{app.name}</h1>
        <div className="detail-meta">
          <a href={appUrl(app.subdomain)} className="app-link" target="_blank" rel="noopener">
            {appHost(app.subdomain)}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3M9 2h5v5M15 1L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </a>
          <span className={`badge ${app.provisioned ? 'active' : 'inactive'}`}>
            {app.provisioned ? 'Provisioned' : 'Not provisioned'}
          </span>
          <span className="badge repo-badge">{app.runtime?.type === 'docker' ? 'Docker' : 'Node'}</span>
          {app.source?.githubRepo && (
            <span className="badge repo-badge">{app.source.githubRepo}</span>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Process status bar */}
      {procStatus && procStatus.status !== 'unavailable' && (
        <div className="process-bar">
          <div className="process-info">
            <span className={`process-dot ${statusInfo.className}`} />
            <span className="process-label">{statusInfo.label}</span>
            {procStatus.status === 'online' && (
              <>
                <span className="process-stat">Uptime: {formatUptime(procStatus.uptime)}</span>
                <span className="process-stat">Memory: {formatMemory(procStatus.memory)}</span>
                <span className="process-stat">CPU: {procStatus.cpu}%</span>
                {procStatus.restarts > 0 && (
                  <span className="process-stat">Restarts: {procStatus.restarts}</span>
                )}
              </>
            )}
          </div>
          <div className="process-actions">
            <button onClick={handleRestart}>Restart</button>
            {procStatus.status === 'online' && (
              <button className="danger" onClick={handleStop}>Stop</button>
            )}
          </div>
        </div>
      )}

      <div className="tabs">
        {TABS.map(tab => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {activeTab === 'deploys' && <DeploysTab app={app} missingRequired={missingRequired} onRefresh={load} />}
        {activeTab === 'env' && <EnvVarsTab app={app} onRefresh={load} />}
        {activeTab === 'logs' && <LogsTab app={app} />}
        {activeTab === 'terminal' && <TerminalTab app={app} />}
        {activeTab === 'settings' && <SettingsTab app={app} onRefresh={load} />}
      </div>
    </div>
  );
}
