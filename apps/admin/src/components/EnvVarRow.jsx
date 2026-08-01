import { useState } from 'react';
import * as api from '../lib/api';

// One variable, on one line.
//
// The old row stacked a name, a row of badges and a description inside a table
// cell, next to a value cell whose height changed depending on whether the value
// was set, secret, defaulted or being edited. Nothing lined up with anything, and
// the row grew and shrank as you moved down the list.
//
// Fixed grid instead: name and its note on the left at a constant height, value
// in the middle, actions right. Editing swaps the value cell in place rather than
// re-flowing the row.

export default function EnvVarRow({ v, appSlug, deletable, onChanged, onError, onReveal, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(null);

  const masked = v.isSecret && v.isSet && shown === null;

  async function save() {
    setBusy(true);
    try {
      await api.setEnvVar(appSlug, v.key, draft);
      setEditing(false); setDraft(''); setShown(null);
      await onChanged();
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className={`var-row ${v.kind === 'reserved' ? 'is-system' : ''} ${!v.isSet && v.required ? 'is-missing' : ''}`}>
      <div className="var-name">
        <code>{v.key}</code>
        <div className="var-tags">
          {v.required && <span className="tag tag-required">required</span>}
          {v.isSecret && <span className="tag tag-secret">secret</span>}
          {!v.isSet && <span className="tag tag-unset">not set</span>}
        </div>
        {v.description && <span className="var-desc">{v.description}</span>}
      </div>

      <div className="var-value">
        {editing ? (
          <div className="var-edit">
            <input
              type={v.isSecret ? 'password' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={v.isSecret ? 'New value' : 'Value'}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setDraft(''); } }}
            />
            <button type="button" className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>
          </div>
        ) : shown !== null ? (
          <code className="var-val">{shown}</code>
        ) : masked ? (
          <code className="var-val var-masked">••••••••</code>
        ) : v.isSet ? (
          <code className="var-val">{v.value}</code>
        ) : (v.default != null && v.default !== '') ? (
          <code className="var-val var-default">{v.default}<span className="tag">default</span></code>
        ) : (
          <span className="var-empty">—</span>
        )}
      </div>

      {!editing && (
        <div className="var-actions">
          {masked && (
            <button type="button" onClick={() => onReveal(v.key, setShown)}>Reveal</button>
          )}
          {shown !== null && <button type="button" onClick={() => setShown(null)}>Hide</button>}
          <button type="button" onClick={() => { setEditing(true); setDraft(v.isSecret ? '' : (v.value ?? '')); }}>
            {v.isSet ? 'Change' : 'Set'}
          </button>
          {deletable && (
            <button type="button" className="link-btn danger" onClick={() => onDelete(v.key)}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}
