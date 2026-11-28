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

// What each of the platform's own volumes holds. Other volumes show their name.
const VOLUME_LABEL = {
  objectdata: 'Uploaded Files (Object Store)',
  pgdata: 'Databases',
  apps: 'Deployed App Code',
  repos: 'Repository Checkouts',
  pm2home: 'App Logs and Process List',
  static: 'Published Static Files',
  backups: 'Backups',
  caddy_data: 'Certificates',
  caddy_config: 'Web Server Config',
  caddy_admin: 'Web Server Admin Socket',
  caddylogs: 'Web Server Logs'
};
const volumeLabel = (name) => VOLUME_LABEL[String(name).replace(/^astrodock_/, '')] || name;

// The rows of the disk table, adding up to Disk Used. Volumes use the size on
// disk when the runner could measure it: Docker's own figure counts only the
// bytes written, which misses space a store reserves ahead. Reclaimable is what
// Free Up Space removes, not everything Docker calls unused.
function diskRows(data) {
  if (!data) return [];
  const by = Object.fromEntries((data.docker || []).map((r) => [r.type, r]));
  const rec = data.reclaimable || {};
  const volSize = Array.isArray(data.volumes)
    ? data.volumes.reduce((n, v) => n + v.size, 0)
    : (by['Local Volumes']?.size || 0);
  const rows = [
    { key: 'Images', ...by.Images, reclaimable: rec.images || 0 },
    { key: 'Containers', ...by.Containers, reclaimable: null },
    { key: 'Local Volumes', ...by['Local Volumes'], size: volSize, reclaimable: null },
    { key: 'Build Cache', ...by['Build Cache'], reclaimable: rec.buildCache || 0 }
  ].map((r) => ({ ...r, label: TYPE_LABEL[r.key] }));
  const counted = rows.reduce((n, r) => n + (r.size || 0), 0);
  rows.push({ key: 'other', label: 'Everything Else', note: 'the operating system, system logs and other files', size: Math.max(0, (data.disk?.used || 0) - counted), reclaimable: null });
  return rows;
}

export default function ServerPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [freeing, setFreeing] = useState(false);
  const [result, setResult] = useState(null);
  const [terminal, setTerminal] = useState({ enabled: false, allowed: false });
  const [layout, setLayout] = useState(null);
  const [confirmNode, ask] = useConfirm();

  async function load() {
    try { setData(await api.getServerDisk()); setError(''); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => {
    load();
    api.getServerExecEnabled().then(setTerminal).catch(() => {});
    api.getPlatformHealth().then((p) => setLayout(p.layout || null)).catch(() => {});
  }, []);

  function freeSpace() {
    const removes = data?.reclaimable?.removes || [];
    ask({
      title: 'Free Up Space?',
      body: (removes.length
        ? `Removes ${removes.length} image${removes.length === 1 ? '' : 's'}: ${removes.join(', ')}. Also clears unused image layers and the build cache. `
        : 'No images to remove right now. Clears unused image layers and the build cache. ')
        + 'Keeps the Astrodock version running, the one before it, the newest two builds of each '
        + 'Dockerfile app, and any image a container uses. Apps, databases, uploads and backups are not touched.',
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
  const reclaimable = data?.reclaimable?.total || 0;
  const rows = diskRows(data);
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
          {result.removed.length
            ? <>Freed <b>{gb(result.freedBytes)}</b>. Removed {result.removed.join(', ')}.</>
            : <>Nothing to remove: every image left is running, is the version before it, or is used by a container. Freed <b>{gb(result.freedBytes)}</b> of layers and build cache.</>}
        </p>
      )}

      {layout?.legacy && (
        <section className="server-layout">
          <div className="tab-header"><h2>Old Network Layout</h2></div>
          <p>This install was set up before the network split. Updates replace the images but never
            the compose file, so it still has:</p>
          <ul>{layout.issues.map((i) => <li key={i.key}>{i.message}</li>)}</ul>
          <p>To fix it, replace the two files and restart, over SSH in the install folder. The
            terminal below cannot do this step, because restarting the platform stops the terminal
            partway through.</p>
          <pre className="server-cmds">{`curl -fsSL https://raw.githubusercontent.com/astrodock/astrodock/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/astrodock/astrodock/main/infra/caddy/Caddyfile -o infra/caddy/Caddyfile
grep -q '^ASTRODOCK_RUNNER_TOKEN=.' .env || echo "ASTRODOCK_RUNNER_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --remove-orphans`}</pre>
        </section>
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
          <div className="tile-foot">what Free Up Space removes, at most</div>
        </div>
        <div className="tile">
          <div className="tile-top"><label>Astrodock Versions Stored</label></div>
          <div className="tile-val">{data ? versions.length : '—'}</div>
          <div className="tile-foot">{data?.runningVersion ? `running ${data.runningVersion}` : ''}</div>
        </div>
      </section>

      <section className="server-section">
        <div className="tab-header"><h2>What Is Using the Disk</h2></div>
        <table className="data-table">
          <thead><tr><th>Kind</th><th>Count</th><th>In Use</th><th>Size on Disk</th><th>Free Up Space Removes</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><strong>{r.label}</strong>{r.note && <span className="server-note"> ({r.note})</span>}</td>
                <td>{r.total ?? '—'}</td>
                <td>{r.active ?? '—'}</td>
                <td>{gb(r.size)}</td>
                <td>{r.reclaimable == null ? '—' : gb(r.reclaimable)}</td>
              </tr>
            ))}
            {data && (
              <tr>
                <td><strong>Total</strong></td><td /><td />
                <td><strong>{gb(disk?.used)}</strong></td>
                <td><strong>{gb(reclaimable)}</strong></td>
              </tr>
            )}
            {!data && <tr><td colSpan={5} className="loading-text">Checking…</td></tr>}
          </tbody>
        </table>
      </section>

      {Array.isArray(data?.volumes) && data.volumes.length > 0 && (
        <section className="server-section">
          <div className="tab-header"><h2>Volumes</h2></div>
          <table className="data-table">
            <thead><tr><th>Holds</th><th>Volume</th><th>Size on Disk</th></tr></thead>
            <tbody>
              {data.volumes.map((v) => (
                <tr key={v.name}>
                  <td><strong>{volumeLabel(v.name)}</strong></td>
                  <td><code>{v.name}</code></td>
                  <td>{gb(v.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {terminal.enabled && terminal.allowed && (
        <section className="server-section">
          <div className="tab-header"><h2>Terminal</h2></div>
          <TerminalTab
            stream={api.serverExecStream}
            title="root@server"
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
