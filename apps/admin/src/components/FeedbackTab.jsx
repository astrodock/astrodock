// What this app's users have reported, and what was said back to them.
//
// The layout is the whole point. Two panes, side by side: what we know, and what
// they were told. They are not one thread with labels, because the failure this
// feature exists to prevent is a stack trace reaching a person who reported a
// bug, and a single thread makes that a matter of noticing a label.
//
// The left pane is where the diagnosis goes. The right pane is where a person
// reads "fixed, reload the page". A reply written by a key that cannot send sits
// in the right pane greyed out with a Send button, which is what an AI draft
// looks like before a human agrees with it.

import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';
import Select from './Select';

const STATUSES = ['new', 'under_review', 'planned', 'in_progress', 'shipped', 'answered', 'declined'];

function when(value) {
  if (!value) return '';
  const d = new Date(value);
  const diff = Date.now() - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export default function FeedbackTab({ app }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('open');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      // `open` is resolved server-side. Filtering a page here dropped open
      // items off the end as soon as an app had more than one page of feedback.
      const data = await api.getFeedback(app.slug, filter === 'all' ? '' : filter);
      setItems(data.feedback);
      setError('');
    } catch (err) { setError(err.message); }
  }, [app.slug, filter]);

  useEffect(() => { load(); }, [load]);

  const openItem = useCallback(async (key) => {
    setSelected(key);
    setDetail(null);
    try { setDetail(await api.getFeedbackItem(app.slug, key)); }
    catch (err) { setError(err.message); setSelected(null); }
  }, [app.slug]);

  // Refresh in place. Clearing `detail` first would unmount the open item and
  // flash the list back for a frame on every note, reply and status change.
  const refresh = useCallback(async () => {
    if (!selected) return;
    try { setDetail(await api.getFeedbackItem(app.slug, selected)); }
    catch (err) { setError(err.message); }
  }, [app.slug, selected]);

  if (selected && detail) {
    return (
      <Detail
        app={app}
        data={detail}
        error={error}
        onBack={() => { setSelected(null); setDetail(null); setError(''); load(); }}
        onChanged={refresh}
      />
    );
  }

  return (
    <div>
      <div className="sec-head">
        <div>
          <h2>Feedback</h2>
          <p>What people using {app.name || app.slug} have told you. A question ends in an answer; something broken becomes a work item.</p>
        </div>
        <div className="sec-actions" style={{ width: 200 }}>
          <Select
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'all', label: 'Everything' },
              ...STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))
            ]}
          />
        </div>
      </div>

      {/* Inline, so a failed refresh does not replace the whole tab with an
          error and leave no way back to what was already loaded. */}
      {error && <div className="error">{error}</div>}

      {items.length === 0 ? (
        <EmptyState
          title="Nothing reported yet"
          body={`Add the widget to ${app.slug} and a button appears for your users. Settings tells you the script tag.`}
        />
      ) : (
        <div className="field-panel">
          {items.map((f) => (
            // Spans, not divs: a <button> may only contain phrasing content, and
            // a div inside one is invalid HTML that browsers merely tolerate.
            <button key={f.key} type="button" className="row-btn" onClick={() => openItem(f.key)}>
              <span className="row-main">
                <span className="k">{f.key}</span>
                <span className="t">{f.title}</span>
              </span>
              <span className="row-meta">
                <span className="chip">{f.status.replace(/_/g, ' ')}</span>
                {f.work && f.work.length > 0 && <span className="chip">{f.work.join(' ')}</span>}
                <span className="dim">{when(f.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ app, data, error, onBack, onChanged }) {
  const f = data.feedback;
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function run(fn) {
    setBusy(true); setErr('');
    try { await fn(); onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="sec-head">
        <div>
          <h2>{f.key} · {f.title}</h2>
          <p>
            {f.category} · reported {when(f.createdAt)}
            {f.submitterEmail ? ` · ${f.submitterEmail}` : ' · anonymous'}
          </p>
        </div>
        <div className="sec-actions">
          <div style={{ width: 170 }}>
            <Select
              value={f.status}
              onChange={(v) => run(() => api.setFeedbackStatus(app.slug, f.key, v))}
              options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
            />
          </div>
          <button type="button" onClick={onBack}>Back</button>
        </div>
      </div>

      {(err || error) && <div className="error">{err || error}</div>}

      <div className="field-panel" style={{ marginBottom: 20 }}>
        <div className="field">
          <div className="lab"><b>What they said</b></div>
          <div className="ctl" style={{ whiteSpace: 'pre-wrap' }}>{f.body}</div>
        </div>
        {f.context && Object.keys(f.context).length > 0 && (
          <div className="field">
            <div className="lab"><b>Where</b><span className="desc">Collected by the widget when they pressed send.</span></div>
            <div className="ctl" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              {Object.entries(f.context).map(([k, v]) => (
                <div key={k} style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  <code>{k}</code> {String(v).slice(0, 120)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="two-pane">
        <section className="pane">
          <h3>Internal</h3>
          <p className="pane-note">Diagnosis, causes, anything technical. Never shown to the person who reported this.</p>
          {data.internal.length === 0 && <p className="dim">No notes yet.</p>}
          {data.internal.map((m) => (
            <div className="msg" key={m.id}>
              <div className="msg-who">{m.authorKind === 'agent' ? `${m.authorId} (key)` : m.authorId || 'operator'} · {when(m.createdAt)}</div>
              <div className="msg-body">{m.body}</div>
            </div>
          ))}
          <textarea
            className="bulk-textarea"
            placeholder="What is actually going on"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => run(async () => { await api.addFeedbackNote(app.slug, f.key, note); setNote(''); })}
          >
            Add note
          </button>
        </section>

        <section className="pane">
          <h3>Said to them</h3>
          <p className="pane-note">What the person reading this needs: that you have it, what changed, and what to do now.</p>
          {data.user.length === 0 && <p className="dim">Nothing sent yet.</p>}
          {data.user.map((m) => (
            <div className={`msg ${m.pending ? 'pending' : ''}`} key={m.id}>
              <div className="msg-who">
                {m.authorKind === 'user' ? 'them' : (m.authorKind === 'agent' ? `${m.authorId} (key)` : m.authorId || 'you')}
                {' · '}{when(m.createdAt)}
                {m.pending && ' · draft, not sent'}
              </div>
              <div className="msg-body">{m.body}</div>
              {m.pending && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => run(() => api.sendFeedbackDraft(app.slug, f.key, m.id))}
                >
                  Send this
                </button>
              )}
            </div>
          ))}
          <textarea
            className="bulk-textarea"
            placeholder="Fixed. Reload the page and the time will stick."
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="primary"
              disabled={busy || !reply.trim()}
              onClick={() => run(async () => { await api.replyToFeedback(app.slug, f.key, reply, false); setReply(''); })}
            >
              Send
            </button>
            <button
              type="button"
              disabled={busy || !reply.trim()}
              onClick={() => run(async () => { await api.replyToFeedback(app.slug, f.key, reply, true); setReply(''); })}
            >
              Save as draft
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
