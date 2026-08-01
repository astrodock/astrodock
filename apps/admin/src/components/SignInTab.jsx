import { useState, useEffect } from 'react';
import { getRedirectUris, addRedirectUri, removeRedirectUri } from '../lib/api';
import useConfirm from '../lib/useConfirm';
import EmptyState from './EmptyState';

// Where this app may send people back after they sign in.
//
// Matched exactly — not by prefix, not by host. That is the rule that stops a
// stolen sign-in code being delivered somewhere it shouldn't, and it means every
// callback an app uses has to be listed here, local development included.

export default function SignInTab({ app }) {
  const [uris, setUris] = useState([]);
  const [uri, setUri] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmNode, ask] = useConfirm();

  const load = () => getRedirectUris(app.slug).then((d) => setUris(d.uris || [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [app.slug]);

  async function add() {
    setError(''); setBusy(true);
    try { await addRedirectUri(app.slug, uri.trim()); setUri(''); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function confirmRemove(u) {
    ask({
      title: 'Stop allowing this address?',
      danger: true,
      confirmLabel: 'Stop allowing it',
      body: (
        <>
          <p>
            Sign-ins that try to come back to <code>{u.uri}</code> will be refused from now on. If
            your app is still using this address, signing in will break for everyone on it.
          </p>
          <p className="hint">
            Nobody is signed out — sessions people already have keep working. You can add the
            address back at any time.
          </p>
        </>
      ),
      onConfirm: async () => {
        try { await removeRedirectUri(app.slug, u.id); await load(); }
        catch (e) { setError(e.message); }
      }
    });
  }

  // From the server, not from window.location: the sign-in host is auth.<domain>,
  // and the dashboard is somewhere else entirely.
  const authUrl = app.auth?.authorizeUrl || `https://${window.location.host}/authorize`;
  const tokenUrl = app.auth?.tokenUrl || `https://${window.location.host}/token`;

  const code = `// 1. send them here (keep the state — you compare it on return)
res.redirect('${authUrl}?app_id=${app.slug}'
  + '&redirect_uri=' + encodeURIComponent(CALLBACK)
  + '&state=' + state);

// 2. on the callback, check state, then exchange server-side
const r = await fetch('${tokenUrl}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: req.query.code,
    app_id: '${app.slug}',
    app_secret: process.env.ASTRODOCK_APP_SECRET,
    redirect_uri: CALLBACK
  })
});
const user = await r.json();   // { userId, email, name }`;

  return (
    <div>
      {confirmNode}

      <div className="sec-head">
        <div>
          <h2>How People Sign In to This App</h2>
          <p>
            Your app sends people here, and Astrodock sends them back with a one-time code you
            exchange on your server. Your app never sees their password — which is also what lets it
            offer passkeys and two-factor without you building either.
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="sec-head" style={{ marginTop: 22 }}>
        <div>
          <h3>Allowed Return Addresses</h3>
          <p>
            After someone signs in, Astrodock will only send them back to an address on this list.
            The match is exact — same protocol, host, port and path — so a stolen sign-in code
            cannot be redirected to somebody else's server.
          </p>
        </div>
      </div>

      {uris.length === 0 ? (
        <EmptyState
          icon="key"
          title="No Return Addresses Yet"
          body="Sign-in will be refused until you add one. It's the URL in your app that handles the callback — usually something ending in /auth/callback."
        />
      ) : (
        <div className="uri-list">
          {uris.map((u) => (
            <div className="uri-row" key={u.id}>
              <code>{u.uri}</code>
              <button type="button" className="secondary" onClick={() => confirmRemove(u)}>
                Stop Allowing
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="field-panel" style={{ marginTop: 14 }}>
        <div className="field">
          <div className="lab">
            <b>Add a return address</b>
            <span className="desc">
              Add every address your app actually uses, including
              <code> http://localhost:…</code> while you are developing. Must start with
              <code> https://</code>, except on localhost, where there is no network to intercept.
            </span>
          </div>
          <div className="ctl">
            <input value={uri} onChange={(e) => setUri(e.target.value)} spellCheck="false"
              onKeyDown={(e) => { if (e.key === 'Enter' && uri.trim()) add(); }}
              placeholder="https://yourapp.example.com/auth/callback" style={{ width: 320 }} />
            <button className="primary" onClick={add} disabled={busy || !uri.trim()}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </div>

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h3>Wiring It Up in Your Code</h3>
          <p>
            Two steps. Send people to the sign-in page with a <code>state</code> value you generate,
            then trade the code they come back with for the user, from your server — never from the
            browser, because the exchange uses your app secret.
          </p>
        </div>
      </div>

      <div className="code-block">
        <div className="code-head">
          <span>Your server</span>
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); }
            catch { /* clipboard blocked — the code is on screen to select */ }
          }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>{code}</pre>
        <p className="code-note">
          Compare the <code>state</code> you sent with the one that comes back, and stop if they
          differ. Without that check, someone can hand one of your users a crafted link and sign
          them in as a different account.
        </p>
      </div>
    </div>
  );
}
