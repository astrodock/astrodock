import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import NewKeyModal from '../components/NewKeyModal';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';

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
      <PageHeader
        title="Access Keys"
        description="A key lets a tool or an AI agent do things here on your behalf — deploy an app, read its logs, change a setting. You decide what each key is allowed to do, and everything it does is recorded under your name."
        action={<button onClick={() => { setOpen(true); setCreated(null); }}>New Key</button>}
      />

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
        <NewKeyModal
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

      {live.length > 0 && (
      <table className="data-table">
        <thead>
          <tr><th>Name</th><th>Can Do</th><th>Apps</th><th>Expires</th><th>Last Used</th><th /></tr>
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
        </tbody>
      </table>
      )}

      {!live.length && (
        <EmptyState
          icon="key"
          title="No Access Keys Yet"
          body="A key lets the astrodock CLI or an AI agent act on your behalf, with only the permissions you choose. Nothing can use the API until you create one."
          action={<button onClick={() => { setOpen(true); setCreated(null); }}>+ New Key</button>}
        />
      )}
    </div>
  );
}
