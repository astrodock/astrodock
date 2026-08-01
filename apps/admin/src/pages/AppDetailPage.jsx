import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../lib/api';
import { appHost, appUrl } from '../lib/appUrl';
import DeploysTab from '../components/DeploysTab';
import EnvVarsTab from '../components/EnvVarsTab';
import LogsTab from '../components/LogsTab';
import SettingsTab from '../components/SettingsTab';
import OperationsTab from '../components/OperationsTab';
import SignInTab from '../components/SignInTab';
import DomainsTab from '../components/DomainsTab';
import useConfirm from '../lib/useConfirm';

const TABS = ['deploys', 'env', 'domains', 'signin', 'logs', 'operations', 'settings'];
const TAB_LABELS = { deploys: 'Deploys', env: 'Variables', domains: 'Domains', signin: 'Sign-in', logs: 'Logs', operations: 'Operations', settings: 'Settings' };

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
  const [confirmNode, ask] = useConfirm();

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

  function handleStop() {
    ask({
      title: 'Stop this app?',
      danger: true,
      confirmLabel: 'Stop it',
      body: (
        <>
          <p>It stops answering requests immediately. Anyone using it right now gets an error.</p>
          <p className="hint">Nothing is deleted — its data, files and settings are all still here,
            and you can start it again whenever you like.</p>
        </>
      ),
      onConfirm: async () => {
        try {
          await api.stopApp(slug);
          setTimeout(loadStatus, 1000);
        } catch (err) {
          setError(err.message);
        }
      }
    });
  }

  if (error && !app) return <div className="error">{error}</div>;
  if (!app) return <p style={{ color: 'var(--text-3)' }}>Loading...</p>;

  const statusInfo = STATUS_LABELS[procStatus?.status] || STATUS_LABELS.unavailable;
  const ledClass = procStatus?.status === 'online' ? 'ok' : (procStatus?.status === 'errored' ? 'crit' : '');

  return (
    <>
      {confirmNode}
    <div>
      <div className="app-detail-head">
        <Link to="/apps" className="adh-back">← Apps</Link>
        <div className="adh-main">
          <div className="adh-id">
            <h1>{app.name}</h1>
            <div className="adh-sub">
              <span className="stt"><span className={`led ${ledClass}`} />{statusInfo.label}</span>
              <a href={appUrl(app.subdomain)} className="ac-host" target="_blank" rel="noopener">
                {appHost(app.subdomain)}
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3M9 2h5v5M15 1L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </a>
              <span className="badge repo-badge">{app.runtime?.type === 'docker' ? 'Docker' : 'Node'}</span>
              <span className={`badge ${app.provisioned ? 'active' : 'inactive'}`}>{app.provisioned ? 'Provisioned' : 'Not provisioned'}</span>
              {app.repoConnected && app.source?.githubRepo && <span className="badge repo-badge">{app.source.githubRepo}</span>}
            </div>
            {app.description && <p className="adh-desc">{app.description}</p>}
          </div>
          <div className="adh-actions">
            <a href={appUrl(app.subdomain)} target="_blank" rel="noopener">Open ↗</a>
            {procStatus && procStatus.status !== 'unavailable' && <button onClick={handleRestart}>Restart</button>}
            {procStatus?.status === 'online' && <button className="danger" onClick={handleStop}>Stop</button>}
          </div>
        </div>
        {procStatus?.status === 'online' && (
          <div className="adh-stats">
            <span className="adh-stat">Uptime <b>{formatUptime(procStatus.uptime)}</b></span>
            <span className="adh-stat">Memory <b>{formatMemory(procStatus.memory)}</b></span>
            <span className="adh-stat">CPU <b>{procStatus.cpu}%</b></span>
            {procStatus.restarts > 0 && <span className="adh-stat">Restarts <b>{procStatus.restarts}</b></span>}
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="tabs">
        {TABS.map(tab => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab] || tab}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {activeTab === 'deploys' && <DeploysTab app={app} missingRequired={missingRequired} onRefresh={load} />}
        {activeTab === 'env' && <EnvVarsTab app={app} onRefresh={load} />}
        {activeTab === 'domains' && <DomainsTab app={app} />}
        {activeTab === 'logs' && <LogsTab app={app} />}
        {activeTab === 'signin' && <SignInTab app={app} />}
        {activeTab === 'operations' && <OperationsTab app={app} />}
        {activeTab === 'settings' && <SettingsTab app={app} onRefresh={load} />}
      </div>
    </div>
    </>
  );
}
