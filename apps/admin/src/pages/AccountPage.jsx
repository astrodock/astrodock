import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import ReauthModal from '../components/ReauthModal';
import PasswordModal from '../components/PasswordModal';
import PageHeader from '../components/PageHeader';
import TotpSetupModal from '../components/TotpSetupModal';
import RecoveryCodesModal from '../components/RecoveryCodesModal';

// How you sign in, and where you're signed in from.
//
// Built on the same field-panel / seg / chip vocabulary as Settings, so this reads
// as part of the dashboard rather than a bolted-on security page.

export default function AccountPage({ theme, onToggleTheme, onSignOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [reauth, setReauth] = useState(null);

  const load = () => api.getAccount().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // Any protected action: run it, and if the server wants a fresh factor, ask once
  // and retry — rather than dropping the operator back at a sign-in screen.
  // Run a protected action. If the server wants a fresh factor, say WHICH action
  // is being confirmed and retry it afterwards, rather than losing the operator's
  // place or bouncing them to sign-in.
  async function guarded(fn, success, action) {
    setError(''); setMsg('');
    try {
      await fn();
      if (success) setMsg(success);
      await load();
    } catch (e) {
      if (e.body?.code === 'reauth_required') {
        setReauth({ action, retry: () => guarded(fn, success, action) });
      } else setError(e.message);
    }
  }

  if (!data) {
    return (
      <div className="settings-page">
        <PageHeader title="Your Account"
          description="How you sign in, and where you are signed in right now." />
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  const f = data.factors;
  const secure = f.totp || f.passkeys.length > 0;
  const last = data.lastLoginAt ? new Date(data.lastLoginAt) : null;
  const role = data.role ? data.role.charAt(0).toUpperCase() + data.role.slice(1) : '';
  const methods = [
    f.passkeys.length ? `${f.passkeys.length} passkey${f.passkeys.length === 1 ? '' : 's'}` : null,
    f.totp ? 'authenticator app' : null,
    f.password ? 'password' : null
  ].filter(Boolean).join(', ');

  return (
    <div className="settings-page account-page">
      <PageHeader title="Your Account"
        description="How you sign in, where you are signed in right now, and how this looks."
        action={onSignOut
          ? <button className="danger" onClick={onSignOut}>Sign Out</button>
          : undefined} />

      {error && <div className="error">{error}</div>}
      {msg && <div className="provision-banner"><strong>{msg}</strong></div>}
      {reauth && (
        <ReauthModal
          action={reauth.action}
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}

      {/* Who you are, at a glance: one row of cells sharing their borders. */}
      <section className="acct-id">
        <div>
          <label>Signed In As</label>
          <div className="acct-email">{data.email}</div>
          <div className="acct-sub">{role} of this dashboard</div>
        </div>
        <div>
          <label>Protection</label>
          <div className="acct-val">{secure ? 'Two Factors' : 'Password Only'}</div>
          <div className="acct-sub">{methods || 'No sign-in method'}</div>
        </div>
        <div>
          <label>Last Sign-In</label>
          <div className="acct-val">{last ? last.toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Never'}</div>
          <div className="acct-sub">{last ? last.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</div>
        </div>
        <div>
          <label>Signed In On</label>
          <div className="acct-val">{data.sessions.length}</div>
          <div className="acct-sub">{data.sessions.length === 1 ? 'device' : 'devices'}</div>
        </div>
      </section>

      {!secure && (
        <p className="acct-alert">
          <b>A password is the only thing protecting this account.</b> A password can be phished or
          reused elsewhere. A passkey cannot: it only works on this site, and there is no shared
          secret for a breach to leak.
        </p>
      )}

      <div className="sec-head"><div><h2>Sign-In Methods</h2><p>What you can use to prove it is you. Approving what your agents ask for takes a passkey or an authenticator code.</p></div></div>
      <section className="acct-grid">
        <Passkeys data={data} guarded={guarded} />
        <Totp data={data} guarded={guarded} reload={load} flash={setMsg}
          onReauth={(err, retry) => err.body?.code === 'reauth_required' ? setReauth({ action: 'Adding an authenticator app', retry }) : setError(err.message)} />
        <Recovery data={data} guarded={guarded} />
        <PasswordSection data={data} guarded={guarded} reload={load} flash={setMsg} />
      </section>

      <Sessions data={data} guarded={guarded} />

      {/* Moved off the sidebar. It is a setting about you, not navigation, and it
          was the only thing down there that did not go anywhere. */}
      {onToggleTheme && (
        <>
          <div className="sec-head acct-sec"><div><h2>Appearance</h2><p>Applies to this browser only, and is remembered here.</p></div></div>
          <div className="field-panel">
            <div className="field">
              <div className="lab">
                <b>Theme</b>
                <span className="desc">Astrodock follows your choice rather than the system setting.</span>
              </div>
              <div className="ctl">
                <div className="seg">
                  <button type="button" className={theme !== 'dark' ? 'sel' : ''}
                    onClick={() => { if (theme === 'dark') onToggleTheme(); }}>Light</button>
                  <button type="button" className={theme === 'dark' ? 'sel' : ''}
                    onClick={() => { if (theme !== 'dark') onToggleTheme(); }}>Dark</button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── WebAuthn browser plumbing ────────────────────────────────────────────────
// Written out rather than imported: this is the credential path, and a CDN script
// here would put a third party inside it.
const b64uToBuf = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// One sign-in method: a cell in the grid, with its state on the right of the
// title and its actions along the bottom.
function Card({ title, status, children, foot }) {
  return (
    <div className="acct-card">
      <div className="acct-card-head"><h3>{title}</h3>{status}</div>
      {children}
      {foot && <div className="acct-card-foot">{foot}</div>}
    </div>
  );
}

const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function Passkeys({ data, guarded }) {
  const [label, setLabel] = useState('');
  const supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;
  const list = data.factors.passkeys;

  async function add() {
    const options = await api.passkeyOptions();
    const cred = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: b64uToBuf(options.challenge),
        user: { ...options.user, id: b64uToBuf(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }))
      }
    });
    await api.passkeyRegister({
      label: label || 'Passkey',
      response: {
        id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          attestationObject: bufToB64u(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : []
        }
      }
    });
    setLabel('');
  }

  return (
    <Card
      title="Passkeys"
      status={<span className={`statusbadge ${list.length ? 'running' : 'stopped'}`}>{list.length ? `${list.length} Active` : 'None'}</span>}
      foot={supported ? (
        <>
          <input value={label} placeholder="Name, e.g. Work Laptop" onChange={(e) => setLabel(e.target.value)} aria-label="Passkey name" />
          <button className="primary" onClick={() => guarded(add, 'Passkey added.', 'Adding a passkey')}>Add Passkey</button>
        </>
      ) : <span className="acct-note">This browser does not support passkeys.</span>}
    >
      <p>Touch ID, Windows Hello or a security key. A passkey cannot be phished, and nothing is stored here for a breach to leak.</p>
      {list.length > 0 && (
        <div className="acct-list">
          {list.map((p) => (
            <div className="acct-item" key={p.id}>
              <div className="acct-item-text">
                <b>{p.label}</b>
                <span>
                  Added {day(p.createdAt)}, {p.lastUsedAt ? `last used ${day(p.lastUsedAt)}` : 'never used'}
                  {p.stale && '. Added under a previous domain, so it no longer works.'}
                </span>
              </div>
              {p.stale && <span className="statusbadge warn">Add Again</span>}
              <button className="sm" onClick={() => guarded(() => api.passkeyRemove(p.id), 'Passkey removed.', 'Removing a passkey')}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Totp({ data, guarded, reload, flash, onReauth }) {
  const [adding, setAdding] = useState(false);
  const on = data.factors.totp;

  return (
    <Card
      title="Authenticator App"
      status={<span className={`statusbadge ${on ? 'running' : 'stopped'}`}>{on ? 'On' : 'Off'}</span>}
      foot={on
        ? <button className="danger sm-wide" onClick={() => guarded(() => api.totpRemove(), 'Authenticator app removed.', 'Removing your authenticator app')}>Remove Authenticator</button>
        : <button onClick={() => setAdding(true)}>Add Authenticator</button>}
    >
      <p>A six-digit code from an app like 1Password or Google Authenticator. Useful where passkeys do not travel, like a shared machine.</p>
      <p className="acct-note">{on ? 'You are asked for a code each time you sign in.' : 'Not set up. Scan a code once, then confirm it works.'}</p>

      {adding && (
        <TotpSetupModal
          onClose={() => setAdding(false)}
          onDone={(msg) => { setAdding(false); flash(msg); reload(); }}
          onError={(err) => onReauth(err, () => setAdding(true))}
        />
      )}
    </Card>
  );
}

function Recovery({ data, guarded }) {
  const [codes, setCodes] = useState(null);
  const n = data.factors.recoveryCodesRemaining;
  const needed = data.factors.totp || data.factors.passkeys.length > 0;

  return (
    <Card
      title="Recovery Codes"
      status={<span className={`statusbadge ${n > 0 ? 'running' : (needed ? 'down' : 'stopped')}`}>{n} Left</span>}
      foot={<button onClick={() => guarded(async () => {
        const r = await api.generateRecoveryCodes(); setCodes(r.codes);
      }, null, 'Generating recovery codes')}>{n > 0 ? 'Generate New Codes' : 'Generate Codes'}</button>}
    >
      <p>Single-use codes for when you lose your phone or your passkey. Keep them somewhere other than the device you sign in with.</p>
      <p className="acct-note">
        {needed && n === 0
          ? <b className="acct-bad">You have no recovery codes. Lose your second factor and you are locked out.</b>
          : 'Generating a new set replaces the old one, which is also how you revoke them.'}
      </p>

      {codes && <RecoveryCodesModal codes={codes} onClose={() => setCodes(null)} />}
    </Card>
  );
}

function PasswordSection({ data, guarded, reload, flash }) {
  const [pwOpen, setPwOpen] = useState(false);
  const has = data.factors.password;
  const canDrop = has && data.factors.passkeys.length > 0;

  return (
    <Card
      title="Password"
      status={<span className={`statusbadge ${has ? 'running' : 'stopped'}`}>{has ? 'Set' : 'Not Set'}</span>}
      foot={(
        <>
          <button onClick={() => setPwOpen(true)}>{has ? 'Change Password' : 'Set a Password'}</button>
          {canDrop && (
            <button className="danger"
              onClick={() => guarded(() => api.removePassword(), 'Password removed. You sign in with a passkey only.', 'Removing your password')}>
              Remove Password
            </button>
          )}
        </>
      )}
    >
      <p>{has
        ? 'Used alongside your other methods. Changing it asks for the current one, and the new one twice.'
        : 'You sign in with a passkey only. A password adds a fallback.'}</p>
      {canDrop && <p className="acct-note">With a passkey set up, you can remove the password and sign in with the passkey alone.</p>}

      {pwOpen && (
        <PasswordModal
          hasPassword={has}
          onClose={() => setPwOpen(false)}
          onSaved={(msg) => { setPwOpen(false); flash(msg); reload(); }}
        />
      )}
    </Card>
  );
}

function Sessions({ data, guarded }) {
  return (
    <>
      <div className="sec-head acct-sec">
        <div><h2>Where You Are Signed In</h2><p>If you do not recognize one, sign it out. It takes effect immediately.</p></div>
        {data.sessions.length > 1 && (
          <button onClick={() => guarded(() => api.revokeOtherSessions(), 'Other sessions signed out.')}>
            Sign Out Everywhere Else
          </button>
        )}
      </div>
      <table className="data-table acct-sessions">
        <thead><tr><th>Device</th><th>IP Address</th><th>Last Seen</th><th /></tr></thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                {(s.userAgent || 'Unknown device').slice(0, 54)}
                {s.current && <span className="statusbadge running acct-this">This Device</span>}
              </td>
              <td><code>{s.ip || 'Unknown'}</code></td>
              <td>{new Date(s.lastSeenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td className="acct-row-action">
                {!s.current && (
                  <button className="sm" onClick={() => guarded(() => api.revokeSession(s.id), 'Signed out.')}>Sign Out</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
