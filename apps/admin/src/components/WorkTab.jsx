// Tracked work for one app.
//
// The column that earns its place is "reported by": an item with three people
// waiting to hear about it is a different priority from one with none, and that
// is only knowable from the link between feedback and work. Closing an item here
// is also the moment you find out who still needs telling.

import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import Select from './Select';

const STATUSES = ['open', 'in_progress', 'done', 'wont_do'];
const TYPES = ['bug', 'feature', 'chore'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

export default function WorkTab({ app }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('open');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', type: 'bug', priority: 'P2', context: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getWorkItems(app.slug, filter === 'all' ? '' : filter);
      setItems(data.items);
      setError('');
    } catch (err) { setError(err.message); }
  }, [app.slug, filter]);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true); setError('');
    try {
      await api.createWorkItem(app.slug, draft);
      setDraft({ title: '', type: 'bug', priority: 'P2', context: '' });
      setAdding(false);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function setStatus(key, status) {
    setBusy(true); setError('');
    try { await api.setWorkItemStatus(app.slug, key, status); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="sec-head">
        <div>
          <h2>Work</h2>
          <p>What needs doing for {app.name || app.slug}. Technical detail belongs here, where no user can read it.</p>
        </div>
        <div className="sec-actions">
          <div style={{ width: 160 }}>
            <Select
              value={filter}
              onChange={setFilter}
              options={[{ value: 'all', label: 'Everything' },
                ...STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))]}
            />
          </div>
          <button type="button" className="primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'New item'}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {adding && (
        <div className="field-panel" style={{ marginBottom: 18 }}>
          <div className="field">
            <div className="lab"><b>Title</b><span className="desc">Short and imperative: what will be true when it is done.</span></div>
            <div className="ctl">
              <input
                value={draft.title}
                style={{ width: 380 }}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <div className="lab"><b>Problem</b><span className="desc">One line, shown under the title in this list.</span></div>
            <div className="ctl">
              <input
                value={draft.context}
                style={{ width: 380 }}
                onChange={(e) => setDraft({ ...draft, context: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <div className="lab"><b>Type and priority</b></div>
            <div className="ctl" style={{ gap: 8 }}>
              <div style={{ width: 140 }}>
                <Select value={draft.type} onChange={(v) => setDraft({ ...draft, type: v })}
                  options={TYPES.map((t) => ({ value: t, label: t }))} />
              </div>
              <div style={{ width: 110 }}>
                <Select value={draft.priority} onChange={(v) => setDraft({ ...draft, priority: v })}
                  options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
              </div>
            </div>
          </div>
          <div className="field">
            <div className="lab" />
            <div className="ctl">
              <button type="button" className="primary" disabled={busy || !draft.title.trim()} onClick={create}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState title="Nothing tracked" message="Work items are what feedback turns into, and anything else you need to remember." />
      ) : (
        <div className="field-panel">
          {items.map((i) => (
            <div className="work-row" key={i.key}>
              <div className="row-main">
                <span className="k">{i.key}</span>
                <div>
                  <div className="t">{i.title}</div>
                  {i.context && <div className="dim">{i.context}</div>}
                </div>
              </div>
              <div className="row-meta">
                <span className="chip">{i.priority}</span>
                <span className="chip">{i.type}</span>
                {i.feedback && i.feedback.length > 0 && (
                  <span className="chip" title="People waiting to hear about this">
                    {i.feedback.length} waiting
                  </span>
                )}
                <div style={{ width: 150 }}>
                  <Select
                    value={i.status}
                    onChange={(v) => setStatus(i.key, v)}
                    options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
