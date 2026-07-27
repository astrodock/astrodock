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
      <div className="sec-head">
        <div>
          <h2>Look inside this app</h2>
          <p>
            Browse the deployed files, check which configuration actually reached the running
            process, and run the commands this app declares in its <code>app.json</code>. There is
            no free-form shell on purpose — commands come from the repository, so they are code
            someone reviewed and committed rather than text assembled from a log line.
          </p>
        </div>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {[['files', 'Files'], ['env', 'Configuration'], ['commands', 'Commands']].map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'sel' : ''} onClick={() => setTab(k)}>{label}</button>
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
      <p className="hint"><code>{path === '.' ? '/' : path}</code></p>
      <div className="field-panel">
        {parent !== null && (
          <div className="field">
            <div className="lab">
              <button className="link-btn" onClick={() => setPath(parent)}>← up a level</button>
            </div>
          </div>
        )}
        {entries.map((e) => (
          <div className="field" key={e.name}>
            <div className="lab">
              <button className="link-btn" style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
                onClick={() => e.type === 'dir'
                  ? setPath(path === '.' ? e.name : `${path}/${e.name}`)
                  : (setError(''), opsFile(slug, path === '.' ? e.name : `${path}/${e.name}`)
                    .then(setFile).catch((err) => setError(err.message)))}>
                {e.name}{e.type === 'dir' ? '/' : ''}
              </button>
            </div>
            <div className="ctl">
              {e.size != null && <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{Math.ceil(e.size / 1024)} KB</span>}
            </div>
          </div>
        ))}
        {!entries.length && (
          <div className="field"><div className="lab" style={{ color: 'var(--text-3)' }}>Nothing here.</div></div>
        )}
      </div>
      {file && (
        <>
          <div className="sec-head" style={{ marginTop: 20 }}><div><h2>{file.path}</h2></div></div>
          <pre className="log-viewer">{file.content}</pre>
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
      <p className="hint">
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
              <td>{r.value != null ? <code>{r.value}</code> : <span style={{ color: 'var(--text-3)' }}>hidden · {r.length} chars</span>}</td>
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
        <div className="rcard warn">
          <span className="led warn" />
          <span>
            <b>This app declares no commands.</b> Add a <code>scripts</code> map to its
            <code> app.json</code> — a <code>migrate</code> entry, say — and it will appear here.
          </span>
        </div>
      ) : (
        <div className="field-panel">
          {commands.map((name) => (
            <div className="field" key={name}>
              <div className="lab">
                <b>{name}</b>
                <span className="desc">Declared in this app's <code>app.json</code>.</span>
              </div>
              <div className="ctl">
                <button className="pillbtn sel" disabled={!!busy} onClick={() => run(name)}>
                  {busy === name ? 'Running…' : 'Run'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {result && (
        <>
          <div className="sec-head" style={{ marginTop: 20 }}>
            <div>
              <h2>{result.name}</h2>
              <p>
                <span className={`chip ${result.exitCode === 0 ? 'ok' : 'crit'}`}>
                  exit {result.exitCode}{result.timedOut ? ' · timed out' : ''}
                </span>{' '}
                <code>{result.command}</code>
              </p>
            </div>
          </div>
          {result.stdout && <pre className="log-viewer">{result.stdout}</pre>}
          {result.stderr && <pre className="log-viewer" style={{ color: 'var(--danger)' }}>{result.stderr}</pre>}
        </>
      )}
    </div>
  );
}
