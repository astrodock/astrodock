import { useState, useEffect } from 'react';
import { opsList, opsFile, opsEnv, opsCommands, opsRun } from '../lib/api';

// Replaces the old Terminal tab. That was a shell running in the control-plane
// container — which holds the key to every app's secrets — and it did not work,
// because the app's files live on the runner. These are the things people
// actually used it for, as named actions with bounded blast radius.

export default function OperationsTab({ app }) {
  const [tab, setTab] = useState('files');
  return (
    <div>
      <div className="callout">
        <b>Look inside this app</b>
        <p>
          Browse the deployed files, check which configuration actually reached the running
          process, and run the commands this app declares in its <code>app.json</code>.
        </p>
        <p>
          There is no free-form shell here on purpose. Commands come from the app's own
          repository, so they are code someone reviewed and committed — not text assembled from a
          log line.
        </p>
      </div>

      <div className="setup-check" style={{ marginBottom: 14 }}>
        {[['files', 'Files'], ['env', 'Configuration'], ['commands', 'Commands']].map(([k, label]) => (
          <button key={k} type="button" className={`pillbtn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'files' && <Files slug={app.slug} />}
      {tab === 'env' && <Env slug={app.slug} />}
      {tab === 'commands' && <Commands slug={app.slug} />}
    </div>
  );
}

function Files({ slug }) {
  const [path, setPath] = useState('.');
  const [entries, setEntries] = useState([]);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError(''); setFile(null);
    opsList(slug, path).then((d) => setEntries(d.entries || [])).catch((e) => setError(e.message));
  }, [slug, path]);

  const parent = path === '.' ? null : path.split('/').slice(0, -1).join('/') || '.';

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <p className="field-help"><code>{path === '.' ? '/' : path}</code></p>
      <div className="dns-rec">
        {parent !== null && (
          <div><button className="link-btn" onClick={() => setPath(parent)}>← up a level</button></div>
        )}
        {entries.map((e) => (
          <div key={e.name}>
            {e.type === 'dir' ? (
              <button className="link-btn" onClick={() => setPath(path === '.' ? e.name : `${path}/${e.name}`)}>
                {e.name}/
              </button>
            ) : (
              <button className="link-btn" onClick={() => {
                setError('');
                opsFile(slug, path === '.' ? e.name : `${path}/${e.name}`)
                  .then(setFile).catch((err) => setError(err.message));
              }}>{e.name}</button>
            )}
            {e.size != null && <span className="rk" style={{ marginLeft: 8 }}>{Math.ceil(e.size / 1024)} KB</span>}
          </div>
        ))}
        {!entries.length && <div className="rp">Nothing here.</div>}
      </div>
      {file && (
        <>
          <p className="setup-section-label">{file.path}</p>
          <pre className="setup-cmd" style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>{file.content}</pre>
        </>
      )}
    </div>
  );
}

function Env({ slug }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    opsEnv(slug).then((d) => setRows(d.env || [])).catch((e) => setError(e.message));
  }, [slug]);

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <p className="field-help">
        What the running process actually sees. Secret values are never shown — only whether they
        are set, and how long they are, which is what tells you if a paste was truncated.
      </p>
      <table className="data-table">
        <thead><tr><th>Key</th><th>Set</th><th>Value</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><code>{r.key}</code></td>
              <td>{r.isSet ? <span className="chip ok">yes</span> : <span className="chip warn">no</span>}</td>
              <td>{r.value != null ? <code>{r.value}</code> : <span className="rk">hidden ({r.length} chars)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Commands({ slug }) {
  const [commands, setCommands] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    opsCommands(slug).then((d) => setCommands(d.commands || [])).catch((e) => setError(e.message));
  }, [slug]);

  async function run(name) {
    setBusy(name); setError(''); setResult(null);
    try { setResult(await opsRun(slug, name)); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {!commands.length ? (
        <div className="callout">
          <b>This app declares no commands.</b>
          <p>
            Add a <code>scripts</code> map to its <code>app.json</code> — for example a
            <code> migrate</code> entry — and it will appear here to run.
          </p>
        </div>
      ) : (
        <div className="dns-rec">
          {commands.map((name) => (
            <div key={name}>
              <b>{name}</b>
              <button className="pillbtn" style={{ marginLeft: 10 }} disabled={!!busy} onClick={() => run(name)}>
                {busy === name ? 'Running…' : 'Run'}
              </button>
            </div>
          ))}
        </div>
      )}
      {result && (
        <>
          <p className="setup-section-label">
            {result.name} — exit {result.exitCode}{result.timedOut ? ' (timed out)' : ''}
          </p>
          <p className="field-help"><code>{result.command}</code></p>
          {result.stdout && <pre className="setup-cmd" style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{result.stdout}</pre>}
          {result.stderr && <pre className="setup-cmd" style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', color: 'var(--danger)' }}>{result.stderr}</pre>}
        </>
      )}
    </div>
  );
}
