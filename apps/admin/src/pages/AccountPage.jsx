import { useState, useEffect } from 'react';
import * as api from '../lib/api';

// How you sign in, and where you are signed in from.
//
// Everything that changes a credential is behind step-up re-auth — the server
// enforces it; this page just makes the prompt bearable by asking once and
// carrying on.

export default function AccountPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reauth, setReauth] = useState(null); // pending action, awaiting confirmation

  const load = () => api.getAccount().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // Wrap any protected action: run it, and if the server wants a fresh factor,
  // ask for one and retry rather than dumping the user back at a login screen.
  async function guarded(fn, successMessage) {
    setError(''); setNotice('');
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      await load();
    } catch (e) {
      if (e.body?.code === 'reauth_required') setReauth(() => () => guarded(fn, successMessage));
      else setError(e.message);
    }
  }

  if (!data) return <div className="content-head"><h1>Your account</h1>{error && <div className="error">{error}</div>}</div>;

  const f = data.factors;
  const onlyWayIn = (f.password ? 1 : 0) + (f.passkeys.length ? 1 : 0) <= 1;

  return (
    <div>
      <div className="content-head">
        <h1>Your account</h1>
        <p className="sub">{data.email} · {data.role}</p>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="callout ok"><b>{notice}</b></div>}
      {reauth && <ReauthPrompt onDone={() => { const go = reauth; setReauth(null); go(); }} onCancel={() => setReauth(null)} />}

      {!f.totp && !f.passkeys.length && (
        <div className="callout warn">
          <b>Your account has one factor.</b>
          <p>
            A password alone can be phished or reused. Add a passkey — it cannot be phished, because
            it only works on this exact site — or an authenticator app.
          </p>
        </div>
      )}

      <Passkeys data={data} guarded={guarded} onlyWayIn={onlyWayIn} />
      <Totp data={data} guarded={guarded} />
      <Recovery data={data} guarded={guarded} />
      <Password data={data} guarded={guarded} />
      <Sessions data={data} guarded={guarded} />
    </div>
  );
}

function ReauthPrompt({ onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="callout">
      <b>Confirm it's you</b>
      <p>Changing how you sign in needs your password again, even though you're already signed in.</p>
      {err && <div className="error">{err}</div>}
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      <div className="setup-check">
        <button className="pillbtn" onClick={async () => {
          try { await api.reauth({ password }); onDone(); }
          catch (e) { setErr(e.message); }
        }}>Confirm</button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
      </div>
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

function Passkeys({ data, guarded, onlyWayIn }) {
  const [label, setLabel] = useState('');
  const supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

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
    <section className="basecard">
      <h2>Passkeys</h2>
      <p className="field-help">
        Sign in with Touch ID, Windows Hello or a security key. A passkey cannot be phished — it only
        works on this exact site — and there is no shared secret for a database breach to leak.
      </p>
      {!supported && <div className="callout warn"><b>This browser doesn't support passkeys.</b></div>}

      {data.factors.passkeys.map((p) => (
        <div className="dns-rec" key={p.id}>
          <div><b>{p.label}</b>{p.stale && <span className="chip warn" style={{ marginLeft: 8 }}>needs re-adding</span>}</div>
          <div className="rp">
            Added {new Date(p.createdAt).toLocaleDateString()}
            {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ' · never used'}
          </div>
          {p.stale && (
            <div className="rp">
              This was added under a different domain, so it no longer works. Remove it and add it again.
            </div>
          )}
          <button className="link-btn" onClick={() => guarded(() => api.passkeyRemove(p.id), 'Passkey removed.')}>
            Remove
          </button>
        </div>
      ))}

      {supported && (
        <div className="setup-check">
          <input placeholder="Name it — e.g. work laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="pillbtn" onClick={() => guarded(add, 'Passkey added.')}>Add a passkey</button>
        </div>
      )}
      {onlyWayIn && data.factors.passkeys.length === 1 && !data.factors.password && (
        <p className="field-help">This is your only way in, so it can't be removed until you set a password.</p>
      )}
    </section>
  );
}

function Totp({ data, guarded }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');

  if (data.factors.totp) {
    return (
      <section className="basecard">
        <h2>Authenticator app</h2>
        <p className="field-help">Enabled. You're asked for a code each time you sign in.</p>
        <button className="link-btn" onClick={() => guarded(() => api.totpRemove(), 'Authenticator app removed.')}>
          Remove
        </button>
      </section>
    );
  }

  return (
    <section className="basecard">
      <h2>Authenticator app</h2>
      <p className="field-help">
        A six-digit code from an app like 1Password or Google Authenticator. Useful where passkeys
        don't travel — a shared machine, or a device that can't sync them.
      </p>
      {!setup ? (
        <button className="pillbtn" onClick={() => guarded(async () => setSetup(await api.totpBegin()))}>
          Set up
        </button>
      ) : (
        <>
          <p className="setup-section-label">Add this to your authenticator app</p>
          <code className="setup-cmd">{setup.secret}</code>
          <p className="field-help">
            Most apps can scan a QR code; if yours can't, type the key above. Then enter the code it
            shows to confirm it's working — nothing is switched on until you do.
          </p>
          <div className="setup-check">
            <input inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="pillbtn" onClick={() => guarded(async () => {
              await api.totpConfirm(code); setSetup(null); setCode('');
            }, 'Authenticator app enabled.')}>Confirm</button>
          </div>
        </>
      )}
    </section>
  );
}

function Recovery({ data, guarded }) {
  const [codes, setCodes] = useState(null);
  const n = data.factors.recoveryCodesRemaining;
  return (
    <section className="basecard">
      <h2>Recovery codes</h2>
      <p className="field-help">
        Single-use codes for when you lose your phone or your passkey. They are the only way back
        into a locked-out account, so keep them somewhere other than the device you sign in with.
      </p>
      {n > 0 && <p className="field-help"><b>{n}</b> unused code{n === 1 ? '' : 's'} remaining.</p>}
      {n === 0 && (data.factors.totp || data.factors.passkeys.length > 0) && (
        <div className="callout warn"><b>You have no recovery codes.</b>
          <p>If you lose your second factor you will not be able to get back in.</p></div>
      )}
      {codes ? (
        <>
          <div className="callout warn">
            <b>Save these now — they are not shown again.</b>
            <p>Generating a new set invalidates any previous codes.</p>
          </div>
          <pre className="setup-cmd">{codes.join('\n')}</pre>
        </>
      ) : (
        <button className="pillbtn" onClick={() => guarded(async () => {
          const r = await api.generateRecoveryCodes(); setCodes(r.codes);
        })}>{n > 0 ? 'Generate new codes' : 'Generate codes'}</button>
      )}
    </section>
  );
}

function Password({ data, guarded }) {
  const [pw, setPw] = useState('');
  const canGoPasswordless = data.factors.passkeys.length > 0 && data.factors.password;
  return (
    <section className="basecard">
      <h2>Password</h2>
      {data.factors.password ? (
        <>
          <div className="setup-check">
            <input type="password" placeholder="New password (12+ characters)" value={pw}
              onChange={(e) => setPw(e.target.value)} />
            <button className="pillbtn" onClick={() => guarded(async () => {
              await api.setPassword(pw); setPw('');
            }, 'Password changed.')}>Change</button>
          </div>
          {canGoPasswordless && (
            <>
              <p className="field-help">
                You have a passkey, so you can drop the password entirely and sign in with the passkey
                alone. Nothing left to phish, reuse or forget.
              </p>
              <button className="link-btn" onClick={() => guarded(() => api.removePassword(), 'Password removed — passkey only.')}>
                Remove my password
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="field-help">You sign in with a passkey only. Setting a password adds a fallback.</p>
          <div className="setup-check">
            <input type="password" placeholder="New password (12+ characters)" value={pw}
              onChange={(e) => setPw(e.target.value)} />
            <button className="pillbtn" onClick={() => guarded(async () => {
              await api.setPassword(pw); setPw('');
            }, 'Password set.')}>Set a password</button>
          </div>
        </>
      )}
    </section>
  );
}

function Sessions({ data, guarded }) {
  return (
    <section className="basecard">
      <h2>Where you're signed in</h2>
      <p className="field-help">If you don't recognise one, sign it out — it takes effect immediately.</p>
      <table className="data-table">
        <thead><tr><th>Device</th><th>IP</th><th>Last seen</th><th /></tr></thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <td>{(s.userAgent || 'Unknown').slice(0, 60)}{s.current && <span className="chip ok" style={{ marginLeft: 8 }}>this one</span>}</td>
              <td><code>{s.ip || '—'}</code></td>
              <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
              <td>{!s.current && (
                <button className="link-btn" onClick={() => guarded(() => api.revokeSession(s.id), 'Signed out.')}>
                  Sign out
                </button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.sessions.length > 1 && (
        <button className="pillbtn" onClick={() => guarded(() => api.revokeOtherSessions(), 'Other sessions signed out.')}>
          Sign out everywhere else
        </button>
      )}
    </section>
  );
}
