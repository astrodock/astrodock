import { useState, useEffect } from 'react';
import * as api from '../lib/api';

const STATUS_COLOR = { active: 'var(--accent)', pending: 'var(--warning)', failed: 'var(--danger)' };

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
    try {
      const r = await api.verifyDomain(app.slug, id);
      await load();
      flash(r.verified ? 'Verified — now serving over HTTPS.' : (r.error || 'Not verified yet.'));
    } catch (err) { setError(err.message); }
  }
  async function remove(id, host) {
    if (!confirm(`Remove ${host}? It will stop routing to this app.`)) return;
    try { await api.deleteDomain(app.slug, id); await load(); } catch (err) { setError(err.message); }
  }
  async function makePrimary(id) {
    try { await api.updateDomain(app.slug, id, { isPrimary: true }); await load(); } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div className="tab-header"><h2>Custom domains</h2></div>
      <p className="hint">
        Serve this app at your own domain (e.g. <code>app.example.com</code>) alongside its
        <code> {app.subdomain}.&lt;base&gt;</code> address. Add the DNS records shown, then click Verify.
      </p>

      {error && <div className="error">{error}</div>}
      {msg && <div className="secret-banner" style={{ padding: '8px 12px' }}>{msg}</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" style={{ flex: 1 }} />
        <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add domain'}</button>
      </form>

      {domains.length === 0 ? (
        <p className="empty-state">No custom domains yet.</p>
      ) : domains.map((d) => (
        <div className="card" key={d.id}>
          <div className="page-header" style={{ marginBottom: 8 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 16 }}>
                {d.hostname} {d.isPrimary && <span className="pill">primary</span>}
              </h2>
              <span style={{ color: STATUS_COLOR[d.status] || 'var(--text-muted)' }}>{d.status}</span>
            </div>
            <div className="modal-actions" style={{ margin: 0 }}>
              {d.status !== 'active' && <button onClick={() => verify(d.id)}>Verify</button>}
              {d.status === 'active' && !d.isPrimary && <button className="secondary" onClick={() => makePrimary(d.id)}>Make primary</button>}
              <button className="danger" onClick={() => remove(d.id, d.hostname)}>Remove</button>
            </div>
          </div>
          {d.status !== 'active' && (
            <>
              <p className="hint">Add these records at your DNS provider:</p>
              <table className="data-table">
                <thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
                <tbody>
                  {(d.records || []).map((r, i) => (
                    <tr key={i}><td>{r.type}</td><td><code>{r.name}</code></td><td><code>{r.value}</code></td></tr>
                  ))}
                </tbody>
              </table>
              {!publicIp && <p className="hint">Tip: set <code>ASTRODOCK_PUBLIC_IP</code> so the A-record value is filled in for you.</p>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
