import { useState, useEffect } from 'react';
import { getRedirectUris, addRedirectUri, removeRedirectUri } from '../lib/api';

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

  const load = () => getRedirectUris(app.slug).then((d) => setUris(d.uris || [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [app.slug]);

  async function add() {
    setError(''); setBusy(true);
    try { await addRedirectUri(app.slug, uri.trim()); setUri(''); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // From the server, not from window.location: the sign-in host is auth.<domain>,
  // and the dashboard is somewhere else entirely.
  const authUrl = app.auth?.authorizeUrl || `https://${window.location.host}/authorize`;
  const tokenUrl = app.auth?.tokenUrl || `https://${window.location.host}/token`;

  return (
    <div>
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


      {uris.length === 0 ? (
        <div className="rcard warn">
          <span className="led warn" />
          <span>
            <b>None registered yet, so sign-in will be refused.</b> Add the URL your app handles the
            callback at — typically <code>/auth/callback</code>.
          </span>
        </div>
      ) : (
        <div className="field-panel">
          {uris.map((u) => (
            <div className="field" key={u.id}>
              <div className="lab"><b style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{u.uri}</b></div>
              <div className="ctl">
                <button className="link-btn danger"
                  onClick={async () => { await removeRedirectUri(app.slug, u.id); load(); }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="field-panel" style={{ marginTop: 14 }}>
        <div className="field">
          <div className="lab">
            <b>Allow a callback URL</b>
            <span className="desc">
              Matched exactly, so add every address your app really uses — including
              <code> http://localhost:…</code> while developing. Must be https, except on localhost
              where there is no network to intercept.
            </span>
          </div>
          <div className="ctl">
            <input value={uri} onChange={(e) => setUri(e.target.value)} spellCheck="false"
              placeholder="https://yourapp.example.com/auth/callback" style={{ width: 320 }} />
            <button className="pillbtn sel" onClick={add} disabled={busy || !uri.trim()}>
              {busy ? 'Adding…' : 'Allow'}
            </button>
          </div>
        </div>
      </div>

      <div className="sec-head" style={{ marginTop: 26 }}><div><h2>What Your App Does</h2></div></div>
      <pre className="log-viewer" style={{ whiteSpace: 'pre-wrap' }}>{`// 1. send them here (keep the state — you compare it on return)
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
const user = await r.json();   // { userId, email, name }`}</pre>
      <div className="rcard warn" style={{ marginTop: 12 }}>
        <span className="led warn" />
        <span>
          <b>Compare the <code>state</code> you sent to the one that comes back.</b> Without it,
          someone can hand your users a crafted link and sign them in as somebody else.
        </span>
      </div>
    </div>
  );
}
