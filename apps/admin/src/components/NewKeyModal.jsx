import { useState } from 'react';
import * as api from '../lib/api';

// Creating an access key.
//
// Permissions are a grouped, indented list of switches rather than a wall of
// pills: twenty undifferentiated chips gave no sense of which ones matter, and
// "delete every app" looked exactly like "read logs".

const EXPIRY_CHOICES = [
  { days: 30, label: '30 Days' },
  { days: 90, label: '90 Days' },
  { days: 365, label: 'One Year' },
  { days: null, label: 'Never' }
];

// Least to most powerful. The previous order was whatever the object happened to
// iterate in, which put "manage the whole platform" second.
const PRESET_ORDER = ['readonly', 'deployer', 'operator', 'platform'];

export default function NewKeyModal({ options, apps, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('deployer');
  const [custom, setCustom] = useState(null); // null = follow the preset
  const [appScope, setAppScope] = useState([]);
  const [expiryDays, setExpiryDays] = useState(90);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!options) return null;

  const presets = PRESET_ORDER
    .map((k) => (options.presets || []).find((p) => p.key === k))
    .filter(Boolean);
  const chosen = presets.find((p) => p.key === preset);
  const effective = custom || chosen?.scopes || [];
  const groups = options.groups || [];

  const toggle = (s) => {
    const base = custom || chosen?.scopes || [];
    setCustom(base.includes(s) ? base.filter((x) => x !== s) : [...base, s]);
  };

  async function create(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      onCreated(await api.createToken({
        name: name.trim(),
        ...(custom ? { scopes: custom } : { preset }),
        apps: appScope,
        expiresInDays: expiryDays
      }));
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal modal-wide" onSubmit={create}
        style={{ maxHeight: '88vh', overflowY: 'auto' }}>
        <h2>New Access Key</h2>

        <p className="hint" style={{ marginTop: '-.9rem' }}>
          {options.delegating
            ? 'This key can only pass on part of what it holds, and cannot let its own keys make further keys.'
            : 'Give it only what it needs — you can always issue another.'}
        </p>

        {error && <div className="error">{error}</div>}

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            placeholder="e.g. Invoices deploy key" />
        </label>

        <div style={{ marginBottom: '1.3rem' }}>
          <div className="opt-group" style={{ marginBottom: 8 }}>
            <header><h4>Starting Point</h4></header>
          </div>
          <div className="seg" style={{ display: 'flex' }}>
            {presets.map((p) => (
              <button type="button" key={p.key} className={!custom && preset === p.key ? 'sel' : ''}
                onClick={() => { setPreset(p.key); setCustom(null); }}>{p.label}</button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 7 }}>
            {custom ? 'Adjusted by hand — pick a starting point to reset.' : chosen?.description}
          </p>
        </div>

        {groups.map((g) => {
          const rows = (options.scopes || []).filter((s) => s.group === g.key);
          if (!rows.length) return null;
          return (
            <div className={`opt-group ${g.key === 'sensitive' ? 'danger' : ''}`} key={g.key}>
              <header>
                <h4>{g.label}</h4>
                <p>{g.description}</p>
              </header>
              <div className="opt-list">
                {rows.map((s) => {
                  const on = effective.includes(s.key);
                  return (
                    <div className={`opt-row ${on ? 'on' : ''} ${s.grantable ? '' : 'disabled'}`} key={s.key}>
                      <span className="name">
                        {s.label}
                        <span className="info" data-tip={s.grantable
                          ? s.description
                          : `${s.description} — this key does not hold it, so it cannot pass it on`}>i</span>
                        <code>{s.key}</code>
                      </span>
                      <span
                        className={`mini-toggle ${on ? 'on' : ''}`}
                        role="switch"
                        aria-checked={on}
                        aria-label={s.label}
                        title={s.grantable ? undefined : 'This key cannot pass that on'}
                        onClick={() => s.grantable && toggle(s.key)}
                        style={s.grantable ? undefined : { cursor: 'not-allowed' }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {effective.includes('apps:delete') && (
          <div className="rcard crit" style={{ marginBottom: 14 }}>
            <span className="led crit" />
            <span><b>Deleting an app destroys its data.</b> Its database and stored files go with it.</span>
          </div>
        )}
        {effective.includes('exec') && (
          <div className="rcard crit" style={{ marginBottom: 14 }}>
            <span className="led crit" />
            <span><b>Running commands is unrestricted.</b> Grant it only to something you would trust with the machine.</span>
          </div>
        )}

        <div className="opt-group">
          <header>
            <h4>Limit To Certain Apps</h4>
            <p>Leave all off for every app, including ones created later.</p>
          </header>
          {apps.length ? (
            <div className="opt-list">
              {apps.map((a) => {
                const on = appScope.includes(a.slug);
                return (
                  <div className={`opt-row ${on ? 'on' : ''}`} key={a.slug}>
                    <span className="name">{a.name}<code>{a.slug}</code></span>
                    <span className={`mini-toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on}
                      aria-label={a.name}
                      onClick={() => setAppScope(on ? appScope.filter((x) => x !== a.slug) : [...appScope, a.slug])} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="hint">No apps yet — this key will cover any you create.</p>
          )}
        </div>

        <div className="opt-group">
          <header>
            <h4>Expires</h4>
            <p>A key that never expires is one you will forget you issued.</p>
          </header>
          <div className="seg" style={{ display: 'flex' }}>
            {EXPIRY_CHOICES.map((c) => (
              <button type="button" key={c.label} className={expiryDays === c.days ? 'sel' : ''}
                onClick={() => setExpiryDays(c.days)}>{c.label}</button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim() || !effective.length}>
            {busy ? 'Creating…' : 'Create Key'}
          </button>
        </div>
      </form>
    </div>
  );
}
