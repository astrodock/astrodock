// What has happened to this app: restarts, stops, deploys, domain changes.
//
// These events were already being recorded, but only the platform-wide Activity
// page showed them, unfiltered. During an outage that is the wrong shape: you
// are looking at one app and the question is "what did we already try, and did
// it work". Scrolling a global feed for a slug is not an answer.
//
// Restart and stop appear here whether they succeeded or failed, which is the
// distinction that was missing entirely — pressing restart and finding no trace
// of it left no way to tell a dead button from a process that died again.

import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';

const SEVERITY_COLOR = { info: 'var(--text-3)', warning: 'var(--warning)', critical: 'var(--danger)' };

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = new Date() - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function HistoryTab({ app }) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const data = await api.getEvents({ limit: 200, appSlug: app.slug });
      setEvents(data.events || []);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [app.slug]);

  const needle = q.trim().toLowerCase();
  const shown = events.filter((ev) => !needle
    || [ev.type, ev.message, ev.actor, ev.severity].filter(Boolean).join(' ').toLowerCase().includes(needle));

  return (
    <div>
      <div className="activity-filters">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Filter this app's history…" />
        <button onClick={load}>Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? null : events.length === 0 ? (
        <EmptyState icon="activity" title="Nothing Recorded Yet"
          body="Deploys, restarts, stops and configuration changes for this app appear here as they happen." />
      ) : shown.length === 0 ? (
        <EmptyState icon="search" title="No Matches"
          body={`Nothing in this app's history matches “${q}”.`} />
      ) : (
        <div className="activity-list">
          {shown.map((ev) => (
            <div key={ev.id} className="activity-row">
              <span className="activity-result" style={{ color: SEVERITY_COLOR[ev.severity] || 'var(--text-3)' }}>
                {ev.type}
              </span>
              <span className="activity-detail">
                <span className="activity-commit-msg">{ev.message}</span>
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
  );
}
