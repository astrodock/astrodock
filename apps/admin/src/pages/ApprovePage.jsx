import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../lib/api';
import PageHeader from '../components/PageHeader';
import ProofPrompt from '../components/ProofPrompt';

// What an access key asked to do beyond its own app: create an app, put an app
// at a custom domain, or give an app someone who already has an account. The
// agent waits until this is approved or declined. See lib/approvals.js.

const KINDS = {
  'app.create': 'Create an App',
  'domain.add': 'Add a Custom Domain',
  'user.access': 'Give an App an Existing Person',
  'app.google_signup': 'Allow Sign-Up with Google'
};

function Row({ label, children }) {
  return (
    <div className="field">
      <div className="lab"><b>{label}</b></div>
      <div className="ctl ctl-text">{children}</div>
    </div>
  );
}

function Details({ a }) {
  const d = a.details || {};
  if (a.kind === 'app.create') {
    return (
      <>
        <Row label="App">{d.name} ({d.slug})</Row>
        {d.subdomain && <Row label="Address">{d.subdomain}</Row>}
        <Row label="Database">{d.database || 'none'}</Row>
        <Row label="File Storage">{d.storage || 'none'}</Row>
        {d.githubRepo && <Row label="Repository">{d.githubRepo}</Row>}
        {Array.isArray(d.env) && <Row label="Settings It Needs">{d.env.length ? d.env.map((v) => v.key).join(', ') : 'None'}</Row>}
      </>
    );
  }
  if (a.kind === 'domain.add') {
    return (
      <>
        <Row label="App">{d.app}</Row>
        <Row label="Domain">{d.hostname}</Row>
      </>
    );
  }
  if (a.kind === 'user.access') {
    return (
      <>
        <Row label="App">{d.app}</Row>
        <Row label="Person">{d.name ? `${d.name}, ${d.email}` : d.email}</Row>
        <Row label="Their Other Apps">{d.otherApps || 0}</Row>
        <Row label="What This Means">The app learns who they are the next time they sign in to it.</Row>
      </>
    );
  }
  if (a.kind === 'app.google_signup') {
    return (
      <>
        <Row label="App">{d.app}</Row>
        <Row label="What This Means">Anyone with a Google account can sign up to this app, and anyone who already has an account here joins it by signing in with Google.</Row>
      </>
    );
  }
  return null;
}

// What became of a request, from its stored status. An approval that expired
// after a person approved it was approved and never used by the agent.
function outcomeOf(a) {
  if (a.status === 'used') return { label: 'Approved, Done', cls: 'running' };
  if (a.status === 'approved') return { label: 'Approved, Not Used Yet', cls: 'running' };
  if (a.status === 'denied') return { label: 'Declined', cls: 'down' };
  if (a.status === 'expired' && a.decidedAt) return { label: 'Approved, Never Used', cls: 'stopped' };
  if (a.status === 'expired') return { label: 'Expired, No Answer', cls: 'stopped' };
  return { label: 'Waiting', cls: 'stopped' };
}

function when(t) {
  return t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function who(p) {
  return p ? (p.name || p.email) : '';
}

function Pending() {
  const [list, setList] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.getApprovals().then((d) => setList(d.approvals || [])).catch((e) => setError(e.message));
    api.getApprovalHistory().then((d) => setHistory(d.approvals || [])).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="settings-page">
      <PageHeader title="Approvals" description="What your agents asked to do beyond the app their key is for." />
      {error && <div className="error">{error}</div>}

      <div className="sec-head"><div><h2>Waiting</h2></div></div>
      {list && !list.length && <p className="hint">Nothing is waiting.</p>}
      {list && list.length > 0 && (
        <div className="field-panel">
          {list.map((a) => (
            <div className="field" key={a.id}>
              <div className="lab"><b>{a.summary}</b><span className="desc">Asked by key "{a.tokenName}", {when(a.createdAt)}</span></div>
              <div className="ctl"><Link to={`/approve/${a.id}`}>Review</Link></div>
            </div>
          ))}
        </div>
      )}

      <div className="sec-head approvals-history-head"><div><h2>History</h2><p>Requests that were answered or expired, newest first.</p></div></div>
      {history && !history.length && <p className="hint">No past requests yet.</p>}
      {history && history.length > 0 && (
        <table className="data-table approvals-history">
          <thead><tr><th>Request</th><th>Key</th><th>Outcome</th><th>Decided By</th><th>Asked</th></tr></thead>
          <tbody>
            {history.map((a) => {
              const o = outcomeOf(a);
              return (
                <tr key={a.id}>
                  <td><Link to={`/approve/${a.id}`}>{a.summary}</Link><div className="approvals-kind">{KINDS[a.kind] || a.kind}</div></td>
                  <td>{a.tokenName}</td>
                  <td><span className={`statusbadge ${o.cls}`}>{o.label}</span></td>
                  <td>{a.decidedBy ? <>{who(a.decidedBy)}<div className="approvals-kind">{when(a.decidedAt)}</div></> : <span className="approvals-kind">Nobody</span>}</td>
                  <td>{when(a.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ApprovePage() {
  const { id } = useParams();
  const [a, setA] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    api.getApproval(id).then((d) => setA(d.approval)).catch((e) => setError(e.message));
  }, [id]);

  if (!id) return <Pending />;
  if (error && !a) return <div className="settings-page"><PageHeader title="Approval" /><div className="error">{error}</div></div>;
  if (!a) return <div className="settings-page"><p className="hint">Loading…</p></div>;

  async function approve(proof) {
    const r = await api.approveApproval(a.id, proof);
    setA(r.approval);
  }
  async function deny() {
    setError('');
    try { setA((await api.denyApproval(a.id)).approval); }
    catch (e) { setError(e.message); }
  }

  const pending = a.status === 'pending';
  const outcome = {
    approved: 'Approved. The agent can go ahead; you can close this tab.',
    denied: 'Declined. The agent has been told no.',
    used: 'Approved and done.',
    expired: a.decidedAt
      ? 'Approved, but the agent did not use it before it expired.'
      : 'This request expired. If the agent still needs it, it will ask again.'
  }[a.status];

  return (
    <div className="settings-page">
      <PageHeader title={KINDS[a.kind] || 'Approval'}
        description={`An agent using the key "${a.tokenName}" asked for this. It is waiting for your answer.`} />
      {error && <div className="error">{error}</div>}

      <div className="field-panel">
        <Row label="Request">{a.summary}</Row>
        <Details a={a} />
        <Row label="Asked">{when(a.createdAt)}</Row>
        {!pending && <Row label="Outcome"><span className={`statusbadge ${outcomeOf(a).cls}`}>{outcomeOf(a).label}</span></Row>}
        {a.decidedAt && <Row label={a.status === 'denied' ? 'Declined By' : 'Approved By'}>{who(a.decidedBy) || 'Unknown'}, {when(a.decidedAt)}</Row>}
        {a.usedAt && <Row label="Used by the Agent">{when(a.usedAt)}</Row>}
      </div>

      {pending ? (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}><div><h2>Confirm</h2><p>If you did not expect this, decline it, and look at what the agent is working on.</p></div></div>
          <ProofPrompt actionLabel="Approve" onProof={approve} target={`approval:${a.id}`} />
          <p style={{ marginTop: 14 }}>
            <button type="button" className="link-btn" onClick={deny}>Decline This Request</button>
          </p>
        </>
      ) : (
        <p className="hint" style={{ marginTop: 20 }}>{outcome} <Link to="/approve">All Approvals</Link></p>
      )}
    </div>
  );
}
