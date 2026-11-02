import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import PageHeader from '../components/PageHeader';
import TerminalTab from '../components/TerminalTab';
import useConfirm from '../lib/useConfirm';

// The machine Astrodock runs on: what fills its disk, freeing space without
// going to the cloud provider's console, and a terminal for everything else.
//
// The terminal runs as root on the host. Only the owner role holds
// `server:exec`, so for everyone else this page is disk and Free Up Space.

function gb(bytes) {
  if (!bytes) return '0 GB';
  const g = bytes / 1073741824; // binary, so the numbers match `df -h` on the server
  return g >= 10 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

const TYPE_LABEL = {
  Images: 'Images',
  Containers: 'Containers',
  'Local Volumes': 'Volumes',
  'Build Cache': 'Build Cache'
};

export default function ServerPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [freeing, setFreeing] = useState(false);
  const [result, setResult] = useState(null);
  const [terminal, setTerminal] = useState({ enabled: false, allowed: false });
  const [confirmNode, ask] = useConfirm();

  async function load() {
    try { setData(await api.getServerDisk()); setError(''); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => {
    load();
    api.getServerExecEnabled().then(setTerminal).catch(() => {});
  }, []);

  function freeSpace() {
    ask({
      title: 'Free Up Space?',
      body: 'Removes old Astrodock versions (keeping the one running and the one before it), '
        + 'older builds of Dockerfile apps (keeping the newest two of each), unused image layers '
        + 'and the build cache. Apps, databases, uploads and backups are not touched.',
      confirmLabel: 'Free Up Space',
      onConfirm: async () => {
        setFreeing(true); setResult(null);
        try {
          const r = await api.freeServerSpace();
          setResult(r);
          await load();
        } catch (err) { setError(err.message); }
        setFreeing(false);
      }
    });
  }

  const disk = data?.disk;
  const pct = disk?.usedPercent || 0;
  const tone = pct >= 85 ? 'crit' : pct >= 70 ? 'warn' : '';
  const reclaimable = (data?.docker || []).reduce((n, r) => n + (r.reclaimable || 0), 0);
  const versions = (data?.platformVersions || []).filter((v) => v.tag !== 'latest');

  return (
    <div>
      {confirmNode}
      <PageHeader
        title="Server"
        description="The machine Astrodock runs on: what is filling its disk, and a terminal for what the dashboard does not cover."
        action={<button className="primary" onClick={freeSpace} disabled={freeing || !data}>
          {freeing ? 'Freeing…' : 'Free Up Space'}
        </button>}
      />

      {error && <div className="error">{error}</div>}
      {result && (
        <p className="server-result">
          Freed <b>{gb(result.freedBytes)}</b>. Removed {result.removed.length} image{result.removed.length === 1 ? '' : 's'}.
        </p>
      )}

      <section className="telemetry server-disk">
        <div className="tile">
          <div className="tile-top"><label>Disk Used</label></div>
          <div className="tile-val">{disk ? pct : '—'}<small>%</small></div>
          <div className="meter"><i className={tone === 'crit' ? 'crit' : ''} style={{ width: `${pct}%` }} /></div>
          <div className="tile-foot">{disk ? `${gb(disk.used)} of ${gb(disk.total)}` : 'Checking…'}</div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Free</label></div>
          <div className="tile-val">{disk ? gb(disk.available).replace(' GB', '') : '—'}<small> GB</small></div>
          <div className="tile-foot">available on /</div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Reclaimable</label></div>
          <div className="tile-val">{data ? gb(reclaimable).replace(' GB', '') : '—'}<small> GB</small></div>
          <div className="tile-foot">what Free Up Space can recover, at most</div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Astrodock Versions Stored</label></div>
          <div className="tile-val">{data ? versions.length : '—'}</div>
          <div className="tile-foot">{data?.runningVersion ? `running ${data.runningVersion}` : ''}</div>
        </div>
      </section>

      <section className="server-section">
        <div className="tab-header"><h2>What Docker Is Storing</h2></div>
        <table className="data-table">
          <thead><tr><th>Kind</th><th>Count</th><th>In Use</th><th>Size</th><th>Reclaimable</th></tr></thead>
          <tbody>
            {(data?.docker || []).map((r) => (
              <tr key={r.type}>
                <td><strong>{TYPE_LABEL[r.type] || r.type}</strong></td>
                <td>{r.total}</td>
                <td>{r.active}</td>
                <td>{gb(r.size)}</td>
                <td>{gb(r.reclaimable)}</td>
              </tr>
            ))}
            {!data && <tr><td colSpan={5} className="loading-text">Checking…</td></tr>}
          </tbody>
        </table>
      </section>

      {terminal.enabled && terminal.allowed && (
        <section className="server-section">
          <div className="tab-header"><h2>Terminal</h2></div>
          <TerminalTab
            stream={api.serverExecStream}
            hint={<>Commands run on the server itself, <b>as root</b>, the same as over SSH. Output has the
              platform's secret values masked. Every command is recorded in Activity, with who ran it.
              Commands stop after 15 minutes or when you leave this page.</>}
            idle="Nothing run yet. Try `df -h` or `docker system df`."
            timeoutText="stopped after 15 minutes"
          />
        </section>
      )}
      {terminal.enabled && !terminal.allowed && (
        <p className="hint server-section">The server terminal is for the owner. Ask the owner if you need a command run.</p>
      )}
    </div>
  );
}
