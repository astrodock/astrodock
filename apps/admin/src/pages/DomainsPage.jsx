import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import DnsRecords from '../components/DnsRecords';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import ChangeBaseDomainModal from '../components/ChangeBaseDomainModal';
import ReauthModal from '../components/ReauthModal';
import useConfirm from '../lib/useConfirm';
import Select from '../components/Select';

const STC = { active: 'ok', pending: 'warn', failed: 'crit' };
const STLABEL = { active: 'live', pending: 'waiting for DNS', failed: 'not connected' };

export default function DomainsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [confirmNode, ask] = useConfirm();
  const [msg, setMsg] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [changeBase, setChangeBase] = useState(false);
  const [reauth, setReauth] = useState(null);
  const [addApp, setAddApp] = useState('');
  const [addHost, setAddHost] = useState('');
  const [setup, setSetup] = useState(null);   // a custom-domain object
  const [manage, setManage] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setData(await api.getAllDomains()); setError(''); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 3500); }

  async function addDomain(e) {
    e.preventDefault();
    if (!addApp || !addHost.trim()) return;
    setBusy(true); setError('');
    try {
      const { domain } = await api.addDomain(addApp, addHost.trim());
      setAddOpen(false); setAddHost('');
      await load();
      setSetup({ ...domain, appSlug: addApp });   // jump straight to DNS steps
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function verify(d) {
    setBusy(true); setError('');
    try { const r = await api.verifyDomain(d.appSlug, d.id); await load(); flash(r.verified ? `${d.hostname} is connected.` : (r.error || 'Not verified yet.')); if (r.verified) setSetup(null); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function removeDomain(d) {
    ask({
      title: 'Remove this domain?',
      danger: true,
      confirmLabel: 'Remove domain',
      body: (
        <>
          <p><code>{d.hostname}</code> will stop pointing at <b>{d.appName}</b>. Anyone who visits
            it gets an error until you add it back or point it somewhere else.</p>
          <p className="hint">The app keeps working at its other addresses, and your DNS records
            stay where they are — remove them at your registrar if you're done with them.</p>
        </>
      ),
      onConfirm: async () => {
        try { await api.deleteDomain(d.appSlug, d.id); setManage(null); await load(); flash('Domain removed.'); }
        catch (err) { setError(err.message); }
      }
    });
  }
  async function setPrimary(d) {
    try { await api.updateDomain(d.appSlug, d.id, { isPrimary: true }); await load(); flash('Primary address updated.'); setManage(null); }
    catch (err) { setError(err.message); }
  }
  async function toggleRedirect(d, val) {
    try { await api.updateDomain(d.appSlug, d.id, { redirectToCanonical: val }); await load(); setManage(null); }
    catch (err) { setError(err.message); }
  }

  if (!data) return <p style={{ color: 'var(--text-3)' }}>{error ? <span className="error">{error}</span> : 'Loading…'}</p>;

  const custom = data.custom || [];
  const appOptions = (data.subdomains || []).map((s) => ({ slug: s.slug, name: s.app }));

  return (
    <>
      {confirmNode}
    <div>
      <PageHeader
        title="Domains"
        description="Every web address this platform answers on, automatic and custom."
        action={<button onClick={() => setAddOpen(true)}>Add a Domain</button>}
      />
      {error && <div className="error">{error}</div>}
      {msg && <div className="provision-banner"><strong>{msg}</strong></div>}

      <div className="basecard">
        <svg className="globe" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="19" stroke="currentColor" strokeWidth="1.6" opacity=".5" /><path d="M5 24h38M24 5c5.5 6 5.5 32 0 38M24 5c-5.5 6-5.5 32 0 38" stroke="currentColor" strokeWidth="1.3" opacity=".8" /><circle cx="24" cy="24" r="3" fill="currentColor" /></svg>
        <div className="bd">
          <h2>Your Main Web Address</h2>
          <div className="dom">{data.baseDomain}</div>
          <div className="meta">Every app and page lives under this. <code>*.{data.baseDomain}</code> already points to your server, so new apps just work — no setup needed.</div>
        </div>
        <div className="hero-side">
          <div className="pill-ok"><span className="led ok" /> {data.tlsMode === 'auto' ? 'HTTPS on · renews itself' : `HTTPS: ${data.tlsMode}`}</div>
          <button className="link-btn" onClick={() => setChangeBase(true)}>Change</button>
        </div>
      </div>

      <div className="sec-head" style={{ marginTop: 34 }}>
        <div><h2>Your Custom Domains</h2><p>Addresses you own and point at Astrodock yourself.</p></div>
        <button onClick={() => setAddOpen(true)}>Add a Domain</button>
      </div>
      {custom.length === 0 ? (
        <EmptyState icon="domains" title="No Custom Domains"
          body="Every app already answers at its own subdomain. Add a custom domain when you want one served at an address you own." />
      ) : (
        <table className="data-table" style={{ marginBottom: 30 }}>
            <thead><tr><th>Domain</th><th>Goes To</th><th>Secure</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {custom.map((d) => (
                <tr key={d.id}>
                  <td><span className="host">{d.isPrimary && <span className="star" title="Main Address">★</span>}{d.status === 'active' ? <a className="link" href={`https://${d.hostname}`} target="_blank" rel="noopener">{d.hostname} ↗</a> : <span className="mono">{d.hostname}</span>}</span></td>
                  <td><Link className="link" to={`/apps/${d.appSlug}`}>the <b>{d.appName}</b> app</Link>{d.redirectToCanonical && <span className="redir"> · redirects to primary</span>}</td>
                  <td>{d.status === 'active' ? <span className="tls ok">on</span> : <span className="tls">—</span>}</td>
                  <td><span className={`chip ${STC[d.status]}`}>{STLABEL[d.status]}</span></td>
                  <td className="actions" style={{ justifyContent: 'flex-end' }}>
                    {d.status === 'active'
                      ? <button onClick={() => setManage(d)}>Manage</button>
                      : <button className="primary" onClick={() => setSetup(d)}>Set up DNS</button>}
                  </td>
                </tr>
              ))}
            </tbody>
        </table>
      )}

      <div className="sec-head" style={{ marginTop: 34 }}><div><h2>Automatic Addresses</h2><p>Given to every app under your base domain. Nothing to set up, and nothing to maintain.</p></div></div>
      <div className="autolist">
        {(data.platform || []).map((p) => (
          <div className="autorow" key={p.host}><span className="led ok" /><span className="ahost">{p.host}</span><span className="agoes">→ {p.label}</span><a className="open" href={`https://${p.host}`} target="_blank" rel="noopener">Open ↗</a></div>
        ))}
        {(data.subdomains || []).map((s) => (
          <div className="autorow" key={s.host}><span className="led ok" /><span className="ahost">{s.host}</span><span className="agoes">→ the <b>{s.app}</b> app</span><a className="open" href={`https://${s.host}`} target="_blank" rel="noopener">Open ↗</a></div>
        ))}
      </div>

      {/* add */}
      {changeBase && (
        <ChangeBaseDomainModal
          current={data.baseDomain}
          tlsMode={data.tlsMode}
          onClose={() => setChangeBase(false)}
          onDone={(msg) => { setChangeBase(false); flash(msg); load(); }}
          onReauth={(retry) => { setChangeBase(false); setReauth({ retry }); }}
        />
      )}

      {reauth && (
        <ReauthModal
          action="Changing your main web address"
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}

      {addOpen && (
        <div className="modal-overlay" onClick={() => setAddOpen(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} noValidate onSubmit={addDomain}>
            <h2>Add a Domain</h2>
            <label>Which app should it open?
              <Select value={addApp} onChange={setAddApp} placeholder="Choose an app…"
                options={appOptions.map((a) => ({ value: a.slug, label: a.name, description: a.slug }))} />
            </label>
            <label>Your domain name
              <input className="mono" value={addHost} onChange={(e) => setAddHost(e.target.value)} placeholder="shop.example.com" required />
            </label>
            <p className="hint">After you add it, we’ll show you exactly what to do next.</p>
            <div className="modal-actions"><button type="button" onClick={() => setAddOpen(false)}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add & show steps'}</button></div>
          </form>
        </div>
      )}

      {/* set up DNS */}
      {setup && (
        <div className="modal-overlay" onClick={() => setSetup(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Connect {setup.hostname}</h2>
            <DnsRecords
              records={setup.records || []}
              lead={`To send ${setup.hostname} to ${setup.appName || 'this app'}, add these records where you bought the domain — GoDaddy, Namecheap, Cloudflare, wherever it lives.`}
              footnote="DNS changes can take a few minutes — sometimes a few hours."
            />
            {setup.status === 'failed' && <div className="callout danger">We looked but couldn’t find the TXT record yet. Double-check it was added exactly as shown, then check again.</div>}
            <div className="modal-actions"><button onClick={() => setSetup(null)}>Close</button><button className="primary" disabled={busy} onClick={() => verify(setup)}>{busy ? 'Checking…' : 'Check it now'}</button></div>
          </div>
        </div>
      )}

      {/* manage */}
      {manage && (
        <div className="modal-overlay" onClick={() => setManage(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{manage.hostname}</h2>
            <div className="mrow"><div className="ml"><b>Goes to the {manage.appName} app</b><span>What people see when they visit {manage.hostname}.</span></div><Link className="link" to={`/apps/${manage.appSlug}`}>Open app →</Link></div>
            <div className="mrow"><div className="ml"><b>Secure (HTTPS) is on</b><span>Visitors get a padlock; the certificate renews itself.</span></div><span className="led ok" /></div>
            {!manage.isPrimary && <div className="mrow"><div className="ml"><b>Make this the main address</b><span>People will see {manage.hostname} as the primary; the app’s other addresses send visitors here.</span></div><button onClick={() => setPrimary(manage)}>Make Primary</button></div>}
            {!manage.isPrimary && <div className="mrow"><div className="ml"><b>Redirect to the main address</b><span>Send anyone who visits {manage.hostname} to the primary domain instead.</span></div><button onClick={() => toggleRedirect(manage, !manage.redirectToCanonical)}>{manage.redirectToCanonical ? 'On' : 'Off'}</button></div>}
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <button className="danger" onClick={() => removeDomain(manage)}>Remove Domain</button>
              <button onClick={() => setManage(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
