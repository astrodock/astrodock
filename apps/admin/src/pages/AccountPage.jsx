import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import ReauthModal from '../components/ReauthModal';

// How you sign in, and where you're signed in from.
//
// Built on the same field-panel / seg / chip vocabulary as Settings, so this reads
// as part of the dashboard rather than a bolted-on security page.

export default function AccountPage() {
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
        <div className="page-header"><h1>Your Account</h1></div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  const f = data.factors;
  const secure = f.totp || f.passkeys.length > 0;

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Your Account</h1>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="provision-banner"><strong>{msg}</strong></div>}
      {reauth && (
        <ReauthModal
          action={reauth.action}
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}

      <div className="basecard">
        <svg className="globe" viewBox="0 0 24 24" fill="none">
          <path d="M12 2.6 4.5 6v5.2c0 4.5 3.2 8.5 7.5 10 4.3-1.5 7.5-5.5 7.5-10V6L12 2.6z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8.7 12.1l2.3 2.3 4.4-4.7" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div>
          <h2>Signed In As</h2>
          <div className="dom">{data.email}</div>
          <div className="meta">
            <span className="chip ok">{data.role}</span>{' '}
            {secure
              ? 'Two factors protect this account.'
              : 'A password is the only thing protecting this account — add a passkey below.'}
            {data.lastLoginAt && ` Last signed in ${new Date(data.lastLoginAt).toLocaleString()}.`}
          </div>
        </div>
      </div>

      {!secure && (
        <div className="rcard warn" style={{ marginBottom: 16 }}>
          <span className="led warn" />
          <span>
            <b>Add a second way to prove it's you.</b> A password can be phished or reused elsewhere.
            A passkey can't — it only works on this exact site, and there's no shared secret for a
            breach to leak.
          </span>
        </div>
      )}

      <Passkeys data={data} guarded={guarded} />
      <Totp data={data} guarded={guarded} />
      <Recovery data={data} guarded={guarded} />
      <PasswordSection data={data} guarded={guarded} />
      <Sessions data={data} guarded={guarded} />
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

function Section({ title, description, children, action }) {
  return (
    <>
      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </>
  );
}

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
    <Section
      title="Passkeys"
      description="Sign in with Touch ID, Windows Hello or a security key. A passkey can't be phished — it only works on this exact site — and there's no shared secret stored here for a breach to leak."
    >
      <div className="field-panel">
        {list.map((p) => (
          <div className="field" key={p.id}>
            <div className="lab">
              <b>{p.label}</b>
              <span className="desc">
                Added {new Date(p.createdAt).toLocaleDateString()}
                {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                {p.stale && ' · added under a previous domain, so it no longer works'}
              </span>
            </div>
            <div className="ctl">
              {p.stale
                ? <span className="chip warn">re-add</span>
                : <span className="chip ok">active</span>}
              <button className="link-btn" onClick={() => guarded(() => api.passkeyRemove(p.id), 'Passkey removed.', 'Removing a passkey')}>
                Remove
              </button>
            </div>
          </div>
        ))}

        <div className="field">
          <div className="lab">
            <b>Add a passkey</b>
            <span className="desc">
              {supported
                ? 'Name it so you can tell your devices apart later.'
                : 'This browser does not support passkeys.'}
            </span>
          </div>
          <div className="ctl">
            <input value={label} placeholder="e.g. work laptop" disabled={!supported}
              onChange={(e) => setLabel(e.target.value)} style={{ width: 200 }} />
            <button className="pillbtn sel" disabled={!supported} onClick={() => guarded(add, 'Passkey added.', 'Adding a passkey')}>
              Add
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Totp({ data, guarded }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const on = data.factors.totp;

  return (
    <Section
      title="Authenticator App"
      description="A six-digit code from an app like 1Password or Google Authenticator. Useful where passkeys don't travel — a shared machine, or a device that can't sync them."
    >
      <div className="field-panel">
        <div className="field">
          <div className="lab">
            <b>Authenticator app</b>
            <span className="desc">
              {on ? "You're asked for a code each time you sign in."
                : 'Not set up. Scan a code once, then confirm it works.'}
            </span>
          </div>
          <div className="ctl">
            <span className={`mini-toggle ${on ? 'on' : ''}`} title={on ? 'Turn off' : 'Set up'}
              onClick={() => {
                if (on) guarded(() => api.totpRemove(), 'Authenticator app removed.', 'Removing your authenticator app');
                else guarded(async () => setSetup(await api.totpBegin()), null, 'Setting up an authenticator app');
              }} />
          </div>
        </div>

        {setup && !on && (
          <div className="field" style={{ display: 'block' }}>
            <div className="lab" style={{ marginBottom: 12 }}>
              <b>Add this key to your authenticator app</b>
              <span className="desc">
                Most apps scan a QR code; if yours can't, type the key. Nothing is switched on until
                you enter a working code below.
              </span>
            </div>
            <div className="preview-box" style={{ marginBottom: 12 }}>
              <span className="prow"><code>{setup.secret}</code></span>
            </div>
            <div className="seg-pills" style={{ alignItems: 'center' }}>
              <input inputMode="numeric" placeholder="123456" value={code}
                onChange={(e) => setCode(e.target.value)} style={{ width: 130, marginTop: 0 }} />
              <button className="pillbtn sel" onClick={() => guarded(async () => {
                await api.totpConfirm(code); setSetup(null); setCode('');
              }, 'Authenticator app enabled.', 'Enabling an authenticator app')}>Confirm</button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function Recovery({ data, guarded }) {
  const [codes, setCodes] = useState(null);
  const n = data.factors.recoveryCodesRemaining;
  const needed = data.factors.totp || data.factors.passkeys.length > 0;

  return (
    <Section
      title="Recovery Codes"
      description="Single-use codes for when you lose your phone or your passkey. They're the only way back into a locked-out account, so keep them somewhere other than the device you sign in with."
    >
      {needed && n === 0 && (
        <div className="rcard crit" style={{ marginBottom: 12 }}>
          <span className="led crit" />
          <span><b>You have no recovery codes.</b> Lose your second factor and you'll be locked out.</span>
        </div>
      )}
      <div className="field-panel">
        <div className="field">
          <div className="lab">
            <b>Unused codes</b>
            <span className="desc">Generating a new set invalidates any codes you already have.</span>
          </div>
          <div className="ctl">
            <span className={`chip ${n > 0 ? 'ok' : 'warn'}`}>{n} left</span>
            <button className="pillbtn" onClick={() => guarded(async () => {
              const r = await api.generateRecoveryCodes(); setCodes(r.codes);
            }, null, 'Generating recovery codes')}>{n > 0 ? 'Generate new' : 'Generate'}</button>
          </div>
        </div>
      </div>
      {codes && (
        <>
          <div className="rcard warn" style={{ marginTop: 12 }}>
            <span className="led warn" />
            <span><b>Save these now.</b> They aren't shown again.</span>
          </div>
          <div className="preview-box" style={{ marginTop: 10 }}>
            {codes.map((c) => <span className="prow" key={c}><code>{c}</code></span>)}
          </div>
        </>
      )}
    </Section>
  );
}

function PasswordSection({ data, guarded }) {
  const [pw, setPw] = useState('');
  const has = data.factors.password;
  const canDrop = has && data.factors.passkeys.length > 0;

  return (
    <Section
      title="Password"
      description={has
        ? 'Used alongside your other factors. With a passkey set up you can remove it entirely.'
        : "You sign in with a passkey only. Setting a password adds a fallback."}
    >
      <div className="field-panel">
        <div className="field">
          <div className="lab">
            <b>{has ? 'Change password' : 'Set a password'}</b>
            <span className="desc">At least 8 characters.</span>
          </div>
          <div className="ctl">
            <input type="password" value={pw} placeholder="New password"
              onChange={(e) => setPw(e.target.value)} style={{ width: 220 }} />
            <button className="pillbtn sel" disabled={!pw} onClick={() => guarded(async () => {
              await api.setPassword(pw); setPw('');
            }, has ? 'Password changed.' : 'Password set.', has ? 'Changing your password' : 'Setting a password')}>Save</button>
          </div>
        </div>

        {canDrop && (
          <div className="field">
            <div className="lab">
              <b>Go passwordless</b>
              <span className="desc">
                Sign in with your passkey alone. Nothing left to phish, reuse or forget.
              </span>
            </div>
            <div className="ctl">
              <button className="link-btn danger"
                onClick={() => guarded(() => api.removePassword(), 'Password removed — passkey only.', 'Removing your password')}>
                Remove my password
              </button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function Sessions({ data, guarded }) {
  return (
    <Section
      title="Where you're signed in"
      description="If you don't recognise one, sign it out — it takes effect immediately."
      action={data.sessions.length > 1 && (
        <button className="pillbtn" onClick={() => guarded(() => api.revokeOtherSessions(), 'Other sessions signed out.')}>
          Sign out everywhere else
        </button>
      )}
    >
      <table className="data-table">
        <thead><tr><th>Device</th><th>IP Address</th><th>Last Seen</th><th /></tr></thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                {(s.userAgent || 'Unknown device').slice(0, 54)}
                {s.current && <span className="chip ok" style={{ marginLeft: 8 }}>this device</span>}
              </td>
              <td><code>{s.ip || '—'}</code></td>
              <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
              <td style={{ textAlign: 'right' }}>
                {!s.current && (
                  <button className="link-btn danger" onClick={() => guarded(() => api.revokeSession(s.id), 'Signed out.')}>
                    Sign out
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
