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
          <h2>Look Inside This App</h2>
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

// The same file browser as Pages — same breadcrumbs, same table, same folder rows.
// It was a stack of settings-style .field rows before, which is an 18px-tall row
// built for a labelled control, not for a directory listing. The list also had no
// floor under it, so every folder change resized the page under the cursor.

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Files({ slug }) {
  const [path, setPath] = useState('.');
  const [entries, setEntries] = useState([]);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setError(''); setFile(null); setLoading(true);
    opsList(slug, path)
      .then((d) => setEntries(d.entries || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug, path]);

  const parent = path === '.' ? null : path.split('/').slice(0, -1).join('/') || '.';
  const crumbs = path === '.' ? [] : path.split('/');

  const open = (e) => {
    const full = path === '.' ? e.name : `${path}/${e.name}`;
    if (e.type === 'dir') { setPath(full); return; }
    setError('');
    opsFile(slug, full).then(setFile).catch((err) => setError(err.message));
  };

  // Directories first, then files, each alphabetical — the order every file
  // browser uses, rather than whatever order the server happened to walk them in.
  const sorted = [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <div className="crumbs">
        <button className={`crumb ${path === '.' ? 'here' : ''}`} onClick={() => setPath('.')}>App root</button>
        {crumbs.map((c, i) => {
          const p = crumbs.slice(0, i + 1).join('/');
          return (
            <span key={p} style={{ display: 'contents' }}>
              <span className="crumb-sep">/</span>
              <button className={`crumb ${p === path ? 'here' : ''}`} onClick={() => setPath(p)}>{c}</button>
            </span>
          );
        })}
      </div>

      {/* A fixed floor: changing folders should not resize the page under your cursor. */}
      <div style={{ minHeight: 260 }}>
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Type</th><th style={{ textAlign: 'right' }}>Size</th></tr>
          </thead>
          <tbody>
            {parent !== null && (
              <tr className="row-up" onClick={() => setPath(parent)}>
                <td colSpan={3}><span className="fname">↰ up one level</span></td>
              </tr>
            )}
            {sorted.map((e) => (
              <tr key={e.name} className="row-dir" onClick={() => open(e)}>
                <td>
                  <span className="fname">
                    {e.type === 'dir' ? (
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M1.6 4.2c0-.6.5-1 1-1h3l1.3 1.5h5.5c.6 0 1 .4 1 1v6.1c0 .6-.4 1-1 1H2.6c-.5 0-1-.4-1-1V4.2z"
                          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M9 1.8H4.4c-.6 0-1 .4-1 1v10.4c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1V5.3L9 1.8z"
                          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        <path d="M9 1.8v3.5h3.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      </svg>
                    )}
                    {e.name}
                  </span>
                </td>
                <td className="text-muted">{e.type === 'dir' ? 'Folder' : 'File'}</td>
                <td className="text-muted" style={{ textAlign: 'right' }}>{fmtSize(e.size)}</td>
              </tr>
            ))}
            {!loading && !sorted.length && (
              <tr><td colSpan={3} className="text-muted" style={{ padding: '28px 16px', textAlign: 'center' }}>
                This folder is empty.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {file && (
        <>
          <div className="sec-head" style={{ marginTop: 20 }}>
            <div><h3>{file.path}</h3></div>
            <button onClick={() => setFile(null)}>Close</button>
          </div>
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
