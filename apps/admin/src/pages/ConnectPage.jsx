import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import PageHeader from '../components/PageHeader';
import ProofPrompt from '../components/ProofPrompt';
import Select from '../components/Select';

// The person's side of `astrodock login`.
//
// An agent ran the command and opened this page. Before handing it a key, show
// where the request came from and what the folder's app.json asks for, so a
// person can tell their own agent from someone else's request, and an app
// they wrote from one they were talked into installing.

const MODES = { none: 'None', internal: 'On This Platform', external: 'Its Own' };

function Row({ label, children }) {
  return (
    <div className="field">
      <div className="lab"><b>{label}</b></div>
      <div className="ctl ctl-text">{children}</div>
    </div>
  );
}

function CodeEntry() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  return (
    <div className="settings-page">
      <PageHeader title="Approve an Agent" description="Enter the code your terminal shows after astrodock login." />
      <form className="field-panel" onSubmit={(e) => { e.preventDefault(); if (code.trim()) navigate(`/connect/${code.trim().toUpperCase()}`); }}>
        <div className="field">
          <div className="lab"><b>Code</b><span className="desc">Eight letters, like BCDF-GHJK.</span></div>
          <div className="ctl">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BCDF-GHJK" autoFocus style={{ width: 160 }} />
            <button type="submit" className="primary">Continue</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function ConnectPage() {
  const { code } = useParams();
  const [login, setLogin] = useState(null);
  const [apps, setApps] = useState([]);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('app');
  const [slug, setSlug] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!code) return;
    api.getCliLogin(code).then((d) => {
      setLogin(d.login);
      if (d.login.manifest?.slug) setSlug(d.login.manifest.slug);
    }).catch((e) => setError(e.message));
    api.getApps().then((d) => setApps(d.apps || [])).catch(() => {});
  }, [code]);

  if (!code) return <CodeEntry />;

  async function approve(proof) {
    const r = await api.approveCliLogin(code, { kind, slug: kind === 'app' ? slug : undefined, ...proof });
    setDone(r.login);
  }

  async function deny() {
    setError('');
    try { await api.denyCliLogin(code); setDone({ status: 'denied' }); }
    catch (e) { setError(e.message); }
  }

  if (error && !login) {
    return (
      <div className="settings-page">
        <PageHeader title="Approve an Agent" />
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!login) return <div className="settings-page"><p className="hint">Loading…</p></div>;

  if (done) {
    return (
      <div className="settings-page">
        <PageHeader title={done.status === 'denied' ? 'Declined' : 'Approved'}
          description={done.status === 'denied'
            ? 'The agent gets no key. You can close this tab.'
            : `Your agent has its key${done.kind === 'app' ? ` for "${done.appSlug}"` : ' for every app'}. You can close this tab and go back to your terminal.`} />
      </div>
    );
  }

  const m = login.manifest;
  const c = login.client || {};
  const pending = login.status === 'pending';
  const newApp = kind === 'app' && m && slug === m.slug && !login.existingApp;
  const chosenOk = kind === 'account' || (slug && (apps.some((a) => a.slug === slug) || (m && slug === m.slug)));

  return (
    <div className="settings-page">
      <PageHeader title="Approve an Agent"
        description="An agent ran astrodock login and is asking for an access key. Approve only if the check code below is the one in your terminal. If you did not run astrodock login just now, decline." />

      {error && <div className="error">{error}</div>}

      <div className="sec-head"><div><h2>Request</h2></div></div>
      <div className="field-panel">
        <Row label="Check Code"><code className="code-lg">{login.checkCode}</code></Row>
        <Row label="Computer">{c.hostname || 'Not given'}</Row>
        <Row label="Folder">{c.folder || 'Not given'}</Row>
        <Row label="Git Remote">{c.gitRemote || 'None'}</Row>
        {login.source === 'fleet' && <Row label="Started By">Your Astrodock account</Row>}
      </div>

      {m && (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}>
            <div><h2>What app.json Asks For</h2><p>From the folder the agent is working in. Read this before giving a key to an app you did not write.</p></div>
          </div>
          <div className="field-panel">
            <Row label="App">{m.name} ({m.slug}){login.existingApp ? ', already on this account' : ', new'}</Row>
            <Row label="Address">{m.subdomain}</Row>
            <Row label="Database">{MODES[m.database] || m.database}</Row>
            <Row label="File Storage">{MODES[m.storage] || m.storage}</Row>
            <Row label="Sign-In">{m.auth === 'platform' ? 'Your users sign in through this platform' : 'Public, no sign-in'}</Row>
            {m.githubRepo && <Row label="Repository">{m.githubRepo}</Row>}
            <Row label="Settings It Needs">
              {m.env.length ? m.env.map((v) => v.key + (v.secret ? ' (secret)' : '')).join(', ') : 'None'}
            </Row>
          </div>
        </>
      )}

      {pending ? (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}><div><h2>Key</h2></div></div>
          <div className="field-panel">
            <label className="field radio-field">
              <input type="radio" name="kind" checked={kind === 'app'} onChange={() => setKind('app')} />
              <div className="lab">
                <b>This App Only (Recommended)</b>
                <span className="desc">The agent can build, deploy and configure one app, and manage its users. If text in the folder tells it to do something else, it cannot reach your other apps.</span>
              </div>
            </label>
            {kind === 'app' && (
              <div className="field">
                <div className="lab"><b>Which App</b>{newApp && <span className="desc">Approving creates it.</span>}</div>
                <div className="ctl">
                  <Select value={slug} onChange={setSlug} placeholder="Choose an App"
                    options={[
                      ...(m && !login.existingApp ? [{ value: m.slug, label: `${m.name} (New)`, description: 'Created when you approve' }] : []),
                      ...apps.map((a) => ({ value: a.slug, label: a.name }))
                    ]} />
                </div>
              </div>
            )}
            <label className="field radio-field">
              <input type="radio" name="kind" checked={kind === 'account'} onChange={() => setKind('account')} />
              <div className="lab">
                <b>Every App</b>
                <span className="desc">The agent can work on all your apps and Pages. Creating an app, adding a domain, or giving an app people who already have accounts still asks you first.</span>
              </div>
            </label>
          </div>

          <div className="sec-head" style={{ marginTop: 26 }}><div><h2>Confirm</h2></div></div>
          <ProofPrompt actionLabel="Approve" onProof={approve} disabled={!chosenOk} target={`cli:${login.userCode.replace('-', '')}`} />
          <p style={{ marginTop: 14 }}>
            <button type="button" className="link-btn" onClick={deny}>Decline This Request</button>
          </p>
        </>
      ) : (
        <p className="hint" style={{ marginTop: 20 }}>
          This request is {login.status}. If your agent still needs a key, run astrodock login again.
        </p>
      )}
    </div>
  );
}
