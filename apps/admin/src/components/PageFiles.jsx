import { useState, useRef, useMemo } from 'react';
import * as api from '../lib/api';
import EmptyState from './EmptyState';

// The files that make up a page.
//
// Nested paths always worked on the server — `a/b/c.css` is a valid name and
// uploads already carried per-file paths — but the UI listed everything flat and
// offered no way to put a file anywhere but the root. So folders existed and were
// unreachable. This groups by prefix, lets you make one, and drops uploads into
// whichever folder you are looking at.
//
// New files were named with window.prompt(), which is an OS dialog with no
// validation, no styling and no idea what a valid page filename is.

const TEXT_EXTS = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'csv', 'xml', 'svg', 'yml', 'yaml'];
const isText = (n) => TEXT_EXTS.includes((n.split('.').pop() || '').toLowerCase());
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// Mirrors validFileName on the server, one segment at a time, so a bad name is
// refused in the dialog rather than by a 400 after the fact.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function validPath(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes('..')) return false;
  return name.split('/').every((seg) => SEGMENT.test(seg));
}

const dirOf = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
const baseOf = (name) => name.slice(name.lastIndexOf('/') + 1);
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

function NewFileModal({ folder, existing, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const full = join(folder, name.trim());
  const clash = existing.includes(full);
  const bad = name.trim() && !validPath(full);
  const ready = name.trim() && !bad && !clash;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        try { await onCreate(full); } finally { setBusy(false); }
      }}>
        <h2>New Text File</h2>
        <p className="hint" style={{ marginTop: '-.9rem' }}>
          It opens in the editor once created. {folder ? <>Going into <code>{folder}/</code>.</> : 'Going into the top level.'}
        </p>

        <label className={bad || clash ? 'has-error' : ''}>
          File Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck="false"
            placeholder="index.html" />
          {bad
            ? <span className="field-error">Letters, numbers, dots, dashes and underscores. Use / for a folder.</span>
            : clash
              ? <span className="field-error">That file already exists.</span>
              : <span className="hint">e.g. <code>about.html</code>, <code>styles/main.css</code>, <code>notes.md</code></span>}
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function NewFolderModal({ parent, existing, onClose, onCreate }) {
  const [name, setName] = useState('');
  const full = join(parent, name.trim());
  const bad = name.trim() && !validPath(full);
  const clash = existing.includes(full);
  const ready = name.trim() && !bad && !clash;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" noValidate onSubmit={(e) => { e.preventDefault(); if (ready) onCreate(full); }}>
        <h2>New Folder</h2>
        <p className="hint" style={{ marginTop: '-.9rem' }}>
          Folders are made of the paths of the files in them, so this one stays empty until
          something is put in it — uploads and new files will go here while it is open.
        </p>

        <label className={bad || clash ? 'has-error' : ''}>
          Folder Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck="false"
            placeholder="assets" />
          {bad
            ? <span className="field-error">Letters, numbers, dots, dashes and underscores only.</span>
            : clash
              ? <span className="field-error">That folder is already there.</span>
              : parent && <span className="hint">Inside <code>{parent}/</code>.</span>}
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!ready}>Create</button>
        </div>
      </form>
    </div>
  );
}

export default function PageFiles({ page, pageId, onChanged, onEdit, onError, flash }) {
  const [cwd, setCwd] = useState('');
  const [extraDirs, setExtraDirs] = useState([]);   // folders made but not yet filled
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const fileRef = useRef();
  const dirRef = useRef();

  const files = page.files || [];

  const { dirs, here } = useMemo(() => {
    const prefix = cwd ? `${cwd}/` : '';
    const inScope = files.filter((f) => f.name.startsWith(prefix));
    const d = new Set();
    const h = [];
    for (const f of inScope) {
      const rest = f.name.slice(prefix.length);
      if (rest.includes('/')) d.add(rest.slice(0, rest.indexOf('/')));
      else h.push(f);
    }
    for (const full of extraDirs) {
      if (dirOf(full) === cwd) d.add(baseOf(full));
    }
    return { dirs: [...d].sort(), here: h.sort((a, b) => a.name.localeCompare(b.name)) };
  }, [files, cwd, extraDirs]);

  async function upload(fileList, relPaths) {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;
    setBusy(true);
    try {
      const paths = arr.map((f, i) => {
        const rel = relPaths?.[i]
          || (f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name);
        return join(cwd, rel);
      });
      const bad = paths.find((p) => !validPath(p));
      if (bad) throw new Error(`"${bad}" is not a valid file path for a page.`);
      await api.uploadPageFiles(pageId, arr, paths);
      await onChanged();
      flash(`Uploaded ${arr.length} file${arr.length > 1 ? 's' : ''}${cwd ? ` to ${cwd}/` : ''}.`);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  // A dropped folder arrives as directory entries, not files, so walk the tree.
  async function walk(entry, prefix = '') {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [{ file, path: prefix + entry.name }];
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const out = [];
      // readEntries returns at most 100 at a time and signals the end with [].
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) out.push(...await walk(e, `${prefix}${entry.name}/`));
      }
      return out;
    }
    return [];
  }

  async function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const items = Array.from(e.dataTransfer?.items || []);
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) {
      setBusy(true);
      try {
        const found = (await Promise.all(entries.map((en) => walk(en)))).flat();
        if (found.length) return upload(found.map((f) => f.file), found.map((f) => f.path));
      } catch (err) { onError(err.message); } finally { setBusy(false); }
    }
    if (e.dataTransfer?.files?.length) upload(e.dataTransfer.files);
  }

  const crumbs = cwd ? cwd.split('/') : [];
  const allNames = files.map((f) => f.name).concat(extraDirs);

  return (
    <div className="card">
      <div className="sec-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Files</h2>
          <p>Everything served under this page's address. Drop files anywhere in this panel to upload them.</p>
        </div>
        <div className="sec-actions">
          <button onClick={() => setNewFolder(true)}>New Folder</button>
          <button onClick={() => setNewFile(true)}>New Text File</button>
          <button onClick={() => fileRef.current?.click()} disabled={busy}>Upload</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
          <input ref={dirRef} type="file" multiple webkitdirectory="" directory="" hidden
            onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        </div>
      </div>

      <div className="crumbs">
        <button className={`crumb ${cwd ? '' : 'here'}`} onClick={() => setCwd('')}>All files</button>
        {crumbs.map((c, i) => {
          const path = crumbs.slice(0, i + 1).join('/');
          return (
            <span key={path}>
              <span className="crumb-sep">/</span>
              <button className={`crumb ${path === cwd ? 'here' : ''}`} onClick={() => setCwd(path)}>{c}</button>
            </span>
          );
        })}
        <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => dirRef.current?.click()}>
          Upload a whole folder
        </button>
      </div>

      <div
        className={`dropzone ${dragging ? 'over' : ''} ${busy ? 'busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}
      >
        {dragging && (
          <div className="drop-hint">
            <b>Drop to upload</b>
            <span>{cwd ? `into ${cwd}/` : 'into the top level'}</span>
          </div>
        )}

        {files.length === 0 && dirs.length === 0 ? (
          <EmptyState icon="file" title="No Files Yet"
            body="Drop files here, upload a folder, or create a text file. Whatever you add is served at this page's address." />
        ) : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Entry</th><th /></tr></thead>
            <tbody>
              {cwd && (
                <tr className="row-up" onClick={() => setCwd(dirOf(cwd))}>
                  <td colSpan={5}><span className="fname">↰ up one level</span></td>
                </tr>
              )}
              {dirs.map((d) => {
                const full = join(cwd, d);
                const count = files.filter((f) => f.name.startsWith(`${full}/`)).length;
                return (
                  <tr key={`d:${full}`} className="row-dir" onClick={() => setCwd(full)}>
                    <td>
                      <span className="fname">
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M1.6 4.2c0-.6.5-1 1-1h3l1.3 1.5h5.5c.6 0 1 .4 1 1v6.1c0 .6-.4 1-1 1H2.6c-.5 0-1-.4-1-1V4.2z"
                            stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        </svg>
                        {d}
                      </span>
                    </td>
                    <td className="text-muted">Folder</td>
                    <td className="text-muted">{count} file{count === 1 ? '' : 's'}</td>
                    <td /><td />
                  </tr>
                );
              })}
              {here.map((f) => (
                <tr key={f.name}>
                  <td><span className="fname">{baseOf(f.name)}</span></td>
                  <td className="text-muted">{f.contentType?.split(';')[0] || '—'}</td>
                  <td className="text-muted">{fmtSize(f.size)}</td>
                  <td>
                    {page.entryFile === f.name
                      ? <span className="chip ok">entry</span>
                      : <button className="link-btn" onClick={() => onChanged({ entryFile: f.name }, 'Entry file set.')}>Make Entry</button>}
                  </td>
                  <td className="actions">
                    <a className="link-btn" href={`${page.url}${f.name}`} target="_blank" rel="noopener">Open</a>
                    {isText(f.name) && <button className="link-btn" onClick={() => onEdit(f.name)}>Edit</button>}
                    <button className="link-btn danger" onClick={async () => {
                      if (!confirm(`Delete "${f.name}"?`)) return;
                      try { await api.deletePageFile(pageId, f.name); await onChanged(); flash('File deleted.'); }
                      catch (err) { onError(err.message); }
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newFile && (
        <NewFileModal
          folder={cwd}
          existing={allNames}
          onClose={() => setNewFile(false)}
          onCreate={async (full) => {
            try {
              await api.savePageFileContent(pageId, full, '');
              setNewFile(false);
              await onChanged();
              onEdit(full);
            } catch (err) { onError(err.message); }
          }}
        />
      )}

      {newFolder && (
        <NewFolderModal
          parent={cwd}
          existing={allNames.map(dirOf).concat(allNames)}
          onClose={() => setNewFolder(false)}
          onCreate={(full) => {
            setExtraDirs((d) => [...d, full]);
            setNewFolder(false);
            setCwd(full);
          }}
        />
      )}
    </div>
  );
}
