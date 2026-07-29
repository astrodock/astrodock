import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';

const STC = { active: 'ok', pending: 'warn', failed: 'crit' };
const STLABEL = { active: 'live', pending: 'waiting for DNS', failed: 'not connected' };

export default function DomainsTab({ app }) {
  const [domains, setDomains] = useState([]);
  const [publicIp, setPublicIp] = useState(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    try {
      const d = await api.getDomains(app.slug);
      setDomains(d.domains || []);
      setPublicIp(d.publicIp);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [app.slug]);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 4000); }

  async function add(e) {
    e.preventDefault();
    if (!hostname.trim()) return;
    setBusy(true); setError('');
    try { await api.addDomain(app.slug, hostname.trim()); setHostname(''); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function verify(id) {
    setError(''); setMsg('');
    try { const r = await api.verifyDomain(app.slug, id); await load(); flash(r.verified ? 'Connected — now serving over HTTPS.' : (r.error || 'Not found yet — give DNS a little longer.')); }
    catch (err) { setError(err.message); }
  }
  async function remove(id, host) {
    if (!confirm(`Remove ${host}? It will stop routing to this app.`)) return;
    try { await api.deleteDomain(app.slug, id); await load(); } catch (err) { setError(err.message); }
  }
  async function makePrimary(id) {
    try { await api.updateDomain(app.slug, id, { isPrimary: true }); await load(); } catch (err) { setError(err.message); }
  }
  async function toggleRedirect(id, redirectToCanonical) {
    try { await api.updateDomain(app.slug, id, { redirectToCanonical }); await load(); } catch (err) { setError(err.message); }
  }

  const hasPrimary = domains.some((d) => d.isPrimary && d.status === 'active');

  return (
    <div>
      <div className="tab-header"><h2>Custom Domains</h2></div>
      <p className="hint">Serve this app at your own domain (like <code>app.example.com</code>) on top of its built-in <code>{app.subdomain}.&lt;base&gt;</code> address. Add the domain, then add the two DNS records we show you.</p>

      {error && <div className="error">{error}</div>}
      {msg && <div className="provision-banner"><strong>{msg}</strong></div>}

      <form onSubmit={add} className="dom-add" noValidate>
        <input className="mono" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" />
        <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add domain'}</button>
      </form>

      {domains.length === 0 ? (
        <EmptyState icon="domains" title="No Custom Domains"
          body="This app already answers at its automatic address. Add a domain to serve it at one you own." />
      ) : domains.map((d) => (
        <div className={`dom-card ${d.status}`} key={d.id}>
          <div className="dom-top">
            <span className="host">
              {d.isPrimary && <span className="star" title="Main Address">★</span>}
              {d.status === 'active'
                ? <a className="link" href={`https://${d.hostname}`} target="_blank" rel="noopener">{d.hostname} ↗</a>
                : <span className="mono">{d.hostname}</span>}
            </span>
            <span className={`chip ${STC[d.status]}`}>{STLABEL[d.status]}</span>
            <div className="dom-actions">
              {d.status !== 'active' && <button className="primary" onClick={() => verify(d.id)}>Check DNS</button>}
              {d.status === 'active' && !d.isPrimary && <button onClick={() => makePrimary(d.id)}>Make Primary</button>}
              {d.status === 'active' && !d.isPrimary && hasPrimary && <button onClick={() => toggleRedirect(d.id, !d.redirectToCanonical)}>{d.redirectToCanonical ? 'Redirect: on' : 'Redirect: off'}</button>}
              <button className="danger" onClick={() => remove(d.id, d.hostname)}>Remove</button>
            </div>
          </div>
          {d.status !== 'active' && (
            <div className="dom-dns">
              <div className="callout">Add these two records at the company where you bought your domain (GoDaddy, Namecheap, Cloudflare…), then click <b>Check DNS</b>.</div>
              {(d.records || []).map((r, i) => (
                <div className="dns-rec" key={i}>
                  <div><span className="rk">Type</span><b>{r.type}</b></div>
                  <div><span className="rk">Name</span><span className="rv">{r.name}</span></div>
                  <div><span className="rk">Value</span><span className="rv" style={{ color: 'var(--info)' }}>{r.value}</span></div>
                  {r.purpose && <div className="rp">{r.purpose}</div>}
                </div>
              ))}
              {!publicIp && <p className="hint">Tip: set <code>ASTRODOCK_PUBLIC_IP</code> so the A-record value is filled in for you.</p>}
            </div>
          )}
          {d.status === 'active' && d.redirectToCanonical && hasPrimary && (
            <p className="hint" style={{ marginTop: 10 }}>Visitors here are redirected to the primary domain, keeping the path.</p>
          )}
        </div>
      ))}
    </div>
  );
}
