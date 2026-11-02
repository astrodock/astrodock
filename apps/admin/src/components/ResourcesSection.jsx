import { useState, useEffect } from 'react';
import * as api from '../lib/api';

// How much of the server one app may use, and how much it sends.
//
// Caps apply only to an app in a container of its own: Dockerfile apps, and
// Node apps on a platform set to ASTRODOCK_NODE_RUNTIME=container. A Node app
// under PM2 shares the runner, and nothing here can cap it.

const mb = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`);

export default function ResourcesSection({ app, onRefresh }) {
  const r = app.resources || {};
  const [memory, setMemory] = useState(r.custom?.memory ? String(r.memoryMb) : '');
  const [cpu, setCpu] = useState(r.custom?.cpu ? String(r.cpuMillis / 1000) : '');
  const [traffic, setTraffic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!r.container) return;
    api.getAppTraffic(app.slug, 24).then(setTraffic).catch(() => setTraffic(null));
  }, [app.slug, r.container]);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setMsg('');
    try {
      const cpuMillis = cpu.trim() === '' ? null : String(Math.round(parseFloat(cpu) * 1000));
      const res = await api.setAppLimits(app.slug, { memoryMb: memory.trim() === '' ? null : memory.trim(), cpuMillis });
      setMsg(res.appliedNow ? 'Saved, and applied to the running app.' : 'Saved. The next deploy starts the app with these caps.');
      onRefresh && onRefresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="set-section">
      <div className="sec-head">
        <div>
          <h2>Resources</h2>
          <p>{r.container
            ? 'This app runs in a container of its own. These caps stop it from using up the server. Leave a field blank for the platform default.'
            : 'This app runs under PM2, alongside other apps, so it has no caps. Apps get caps when the platform builds them into containers of their own.'}</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <p className="hint">{msg}</p>}
      {r.container && (
        <form className="field-panel" onSubmit={save} noValidate>
          <div className="field">
            <div className="lab">
              <b>Memory (MB)</b>
              <span className="desc">Now {r.memoryMb} MB{r.custom?.memory ? '' : ' (the default)'}. Up to {r.max?.memoryMb} MB.</span>
            </div>
            <div className="ctl"><input inputMode="numeric" value={memory} placeholder={String(r.memoryMb)} onChange={(e) => setMemory(e.target.value.replace(/\D/g, ''))} style={{ width: 120 }} /></div>
          </div>
          <div className="field">
            <div className="lab">
              <b>CPU (Cores)</b>
              <span className="desc">Now {(r.cpuMillis / 1000).toFixed(2)}{r.custom?.cpu ? '' : ' (the default)'}. Up to {(r.max?.cpuMillis / 1000).toFixed(2)}.</span>
            </div>
            <div className="ctl"><input inputMode="decimal" value={cpu} placeholder={(r.cpuMillis / 1000).toFixed(2)} onChange={(e) => setCpu(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: 120 }} /></div>
          </div>
          <div className="field">
            <div className="lab">
              <b>Traffic, Last 24 Hours</b>
              <span className="desc">Everything the app received and sent, including its own calls out to other services.</span>
            </div>
            <div className="ctl ctl-text">{traffic ? `${mb(traffic.rxBytes)} in, ${mb(traffic.txBytes)} out` : 'Not measured yet'}</div>
          </div>
          <div className="field">
            <div className="lab" />
            <div className="ctl"><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save Caps'}</button></div>
          </div>
        </form>
      )}
    </section>
  );
}
