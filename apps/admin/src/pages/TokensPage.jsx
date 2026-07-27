import { useState, useEffect } from 'react';
import * as api from '../lib/api';

// Access keys — what you hand an agent.
//
// The previous page offered two checkboxes, "deploy" and "pages", where deploy
// quietly included deleting an app along with its database. This one makes the
// grant legible: pick a starting point, see what it actually covers, narrow it.

const EXPIRY_CHOICES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
  { days: null, label: 'Never' }
];

// A readable gist, so the table says something useful without listing 20 scopes.
function summarise(scopes) {
  const bits = [];
  if (scopes.includes('deploys:write')) bits.push('deploy');
  if (scopes.includes('env:write')) bits.push('set config');
  if (scopes.includes('users:write')) bits.push('manage users');
  if (scopes.includes('settings:write')) bits.push('change settings');
  if (scopes.includes('apps:delete')) bits.push('delete apps');
  if (scopes.includes('tokens:write')) bits.push('make keys');
  if (scopes.includes('exec')) bits.push('run commands');
  if (!bits.length) bits.push(scopes.some((s) => s.endsWith(':read')) ? 'read only' : '—');
  return bits.join(' · ');
}

export default function TokensPage() {
  const [tokens, setTokens] = useState([]);
  const [apps, setApps] = useState([]);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () => api.getTokens().then((d) => setTokens(d.tokens || [])).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api.getApps().then((d) => setApps(d.apps || [])).catch(() => {});
    api.getTokenOptions().then(setOptions).catch(() => {});
  }, []);

  const live = tokens.filter((t) => !t.revokedAt);
  const legacy = live.filter((t) => t.legacy);

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Access keys</h1>
        <button onClick={() => { setOpen(true); setCreated(null); }}>+ New key</button>
      </div>

      <p className="hint">
        A key lets the <code>astrodock</code> CLI or an AI agent act on your behalf. Each one carries
        only the permissions you give it, and every action it takes is recorded against you.
      </p>

      {error && <div className="error">{error}</div>}

      {created && (
        <>
          <div className="rcard warn" style={{ marginBottom: 10 }}>
            <span className="led warn" />
            <span><b>Copy this now — it isn't shown again.</b> {created.note}</span>
          </div>
          <div className="secret-banner">
            <strong>{created.name}</strong>
            <code>{created.token}</code>
            <div className="modal-actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
              <button onClick={() => { navigator.clipboard.writeText(created.token); setCopied(true); }}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button onClick={() => { setCreated(null); setCopied(false); }}>Dismiss</button>
            </div>
          </div>
        </>
      )}

      {open && !created && (
        <NewKey
          options={options}
          apps={apps}
          onCancel={() => setOpen(false)}
          onCreated={(k) => { setCreated(k); setOpen(false); load(); }}
        />
      )}

      {legacy.length > 0 && (
        <div className="rcard warn" style={{ marginBottom: 14 }}>
          <span className="led warn" />
          <span>
            <b>{legacy.length} key{legacy.length === 1 ? '' : 's'} predate the current permissions.</b>{' '}
            They still work — the old <code>deploy</code> scope now means the Deployer set, without
            deleting apps or running commands. Reissue them when convenient to see exactly what each
            one can do.
          </span>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr><th>Name</th><th>Can do</th><th>Apps</th><th>Expires</th><th>Last used</th><th /></tr>
        </thead>
        <tbody>
          {live.map((t) => (
            <tr key={t.id}>
              <td>
                <b>{t.name}</b>
                {t.delegated && <span className="chip" style={{ marginLeft: 8 }}>made by a key</span>}
                {t.legacy && <span className="chip warn" style={{ marginLeft: 8 }}>legacy</span>}
              </td>
              <td>
                <span className="chip ok">{t.effectiveScopes.length}</span>{' '}
                <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{summarise(t.effectiveScopes)}</span>
              </td>
              <td>{t.appScope?.length ? t.appScope.join(', ') : <span style={{ color: 'var(--text-3)' }}>all</span>}</td>
              <td>
                {t.expired ? <span className="chip crit">expired</span>
                  : t.expiresAt ? new Date(t.expiresAt).toLocaleDateString()
                    : <span className="chip warn">never</span>}
              </td>
              <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString()
                : <span style={{ color: 'var(--text-3)' }}>never</span>}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="link-btn danger" onClick={async () => {
                  if (!confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`)) return;
                  try {
                    const r = await api.deleteToken(t.id);
                    if (r?.revokedChildren) setError(`Also revoked ${r.revokedChildren} key(s) this one created.`);
                    load();
                  } catch (e) { setError(e.message); }
                }}>Revoke</button>
              </td>
            </tr>
          ))}
          {!live.length && <tr><td colSpan={6} style={{ color: 'var(--text-3)' }}>No keys yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function NewKey({ options, apps, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('deployer');
  const [custom, setCustom] = useState(null); // null = follow the preset
  const [appScope, setAppScope] = useState([]);
  const [expiryDays, setExpiryDays] = useState(90);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!options) return null;
  const presets = options.presets || [];
  const chosen = presets.find((p) => p.key === preset);
  const effective = custom || chosen?.scopes || [];

  const toggle = (s) => {
    const base = custom || chosen?.scopes || [];
    setCustom(base.includes(s) ? base.filter((x) => x !== s) : [...base, s]);
  };

  async function create() {
    setError(''); setBusy(true);
    try {
      onCreated(await api.createToken({
        name: name.trim(),
        ...(custom ? { scopes: custom } : { preset }),
        apps: appScope,
        expiresInDays: expiryDays
      }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="sec-head">
        <div>
          <h2>New access key</h2>
          <p>
            {options.delegating
              ? 'A key can only pass on part of what it holds, and cannot let its own keys make further keys.'
              : 'Give it only what it needs — you can always issue another.'}
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="field-panel" style={{ marginBottom: 14 }}>
        <div className="field">
          <div className="lab">
            <b>Name</b>
            <span className="desc">So you recognise it in the list later.</span>
          </div>
          <div className="ctl">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder="e.g. invoices deploy key" style={{ width: 260 }} />
          </div>
        </div>

        <div className="field">
          <div className="lab">
            <b>Starting point</b>
            <span className="desc">{chosen?.description}</span>
          </div>
          <div className="ctl">
            <div className="seg">
              {presets.map((p) => (
                <button key={p.key} type="button" className={!custom && preset === p.key ? 'sel' : ''}
                  onClick={() => { setPreset(p.key); setCustom(null); }}>{p.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="field" style={{ display: 'block' }}>
          <div className="lab" style={{ marginBottom: 10 }}>
            <b>Permissions</b>
            <span className="desc">
              {custom ? 'Adjusted by hand — pick a starting point above to reset.'
                : 'From the starting point above. Click any to adjust.'}
            </span>
          </div>
          <div className="seg-pills">
            {(options.scopes || []).map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.grantable ? s.description : `${s.description} — this key cannot pass that on`}
                disabled={!s.grantable}
                className={`pillbtn ${effective.includes(s.key) ? 'sel' : ''}`}
                style={!s.grantable ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
                onClick={() => s.grantable && toggle(s.key)}
              >
                {s.key}
              </button>
            ))}
          </div>
          {effective.includes('apps:delete') && (
            <div className="rcard crit" style={{ marginTop: 12 }}>
              <span className="led crit" />
              <span><b>Deleting an app destroys its data.</b> Its database and stored files go with it.</span>
            </div>
          )}
          {effective.includes('exec') && (
            <div className="rcard crit" style={{ marginTop: 12 }}>
              <span className="led crit" />
              <span><b>Running commands is unrestricted.</b> Grant it only to something you'd trust with the machine.</span>
            </div>
          )}
        </div>

        <div className="field">
          <div className="lab">
            <b>Limit to certain apps</b>
            <span className="desc">Leave empty for every app, including ones created later.</span>
          </div>
          <div className="ctl">
            <div className="seg-pills" style={{ justifyContent: 'flex-end', maxWidth: 430 }}>
              {apps.map((a) => (
                <button key={a.slug} type="button"
                  className={`pillbtn ${appScope.includes(a.slug) ? 'sel' : ''}`}
                  onClick={() => setAppScope(appScope.includes(a.slug)
                    ? appScope.filter((x) => x !== a.slug) : [...appScope, a.slug])}>
                  {a.slug}
                </button>
              ))}
              {!apps.length && <span style={{ color: 'var(--text-3)', fontSize: 13 }}>No apps yet</span>}
            </div>
          </div>
        </div>

        <div className="field">
          <div className="lab">
            <b>Expires</b>
            <span className="desc">A key that never expires is one you'll forget you issued.</span>
          </div>
          <div className="ctl">
            <div className="seg">
              {EXPIRY_CHOICES.map((c) => (
                <button key={c.label} type="button" className={expiryDays === c.days ? 'sel' : ''}
                  onClick={() => setExpiryDays(c.days)}>{c.label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="seg-pills" style={{ marginBottom: 22 }}>
        <button className="pillbtn sel" disabled={busy || !name.trim() || !effective.length} onClick={create}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
