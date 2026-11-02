// A terminal for one app, and for the server itself (the Server page).
//
// Command-and-stream, not a pty: you type a command, output arrives as it is
// produced, and you get the exit code. No vim, no top, no interactive prompts.
// That is what an outage actually needs, and it avoids a native dependency in
// the runner image.
//
// The app terminal only appears when the platform has
// ASTRODOCK_ENABLE_TERMINAL=true and the caller holds `exec`, which no key
// preset grants and the operator role does not carry. Every command is written
// to the audit trail before it runs, and shows up in this app's History tab.
//
// One dark panel: scrollback on top, the prompt on the last line, the way a
// shell looks. The prompt is a textarea, so a pasted multi-line script lands
// whole and can be edited before it is sent. Enter runs, Shift+Enter adds a
// line. Each command's output has its own copy button; the bar copies all.

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import * as api from '../lib/api';

const MAX_BLOCKS = 200;

function blockText(b) {
  return b.out.map((o) => o.text).join('');
}

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch { /* clipboard refused: the text is still selectable */ }
  }
  return (
    <button type="button" className="tty-btn" onClick={copy} disabled={!text}>
      {done ? 'Copied' : label}
    </button>
  );
}

// Also the Server page's terminal: pass `stream`, `hint`, `idle`, `title` and
// `timeoutText` to point it somewhere other than one app.
export default function TerminalTab({ app, stream, hint, idle, title, timeoutText = 'timed out after 5 minutes' }) {
  const [command, setCommand] = useState('');
  const [blocks, setBlocks] = useState([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [histAt, setHistAt] = useState(-1);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const draftRef = useRef('');

  // Follow the tail only when already at it, so reading scrollback is not
  // yanked away by output still arriving.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atTail = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atTail) el.scrollTop = el.scrollHeight;
  }, [blocks, running]);

  // The prompt grows with what is typed or pasted, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [command]);

  useEffect(() => { if (!running) inputRef.current?.focus({ preventScroll: true }); }, [running]);

  function append(stream, text) {
    setBlocks((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      return [...prev.slice(0, -1), { ...last, out: [...last.out, { stream, text }] }];
    });
  }

  function finish(exit) {
    setBlocks((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      return [...prev.slice(0, -1), { ...last, exit, done: true }];
    });
  }

  async function run() {
    const cmd = command.replace(/\s+$/, '');
    if (!cmd.trim() || running) return;

    setHistory((h) => (h[0] === cmd ? h : [cmd, ...h].slice(0, 50)));
    setHistAt(-1);
    draftRef.current = '';
    setBlocks((prev) => [...prev, { cmd, out: [], exit: null, done: false }].slice(-MAX_BLOCKS));
    setCommand('');
    setRunning(true);

    const ctl = new AbortController();
    abortRef.current = ctl;
    let exited = false;
    try {
      const send = stream || ((c, sig, on) => api.execStream(app.slug, c, sig, on));
      await send(cmd, ctl.signal, (event, data) => {
        if (event === 'stdout' || event === 'stderr') append(event, data);
        else if (event === 'exit') {
          exited = true;
          finish(data.timedOut
            ? { text: timeoutText, bad: true }
            : { text: `exit ${data.code ?? ''}${data.signal ? ` (${data.signal})` : ''}`.trim(), bad: data.code !== 0 });
        } else if (event === 'error') append('stderr', String(data));
      });
    } catch (err) {
      if (err.name !== 'AbortError') append('stderr', err.message);
    }
    if (!exited) finish({ text: ctl.signal.aborted ? 'stopped' : 'ended', bad: true });
    setRunning(false);
    abortRef.current = null;
  }

  function stop() {
    if (abortRef.current) abortRef.current.abort();
  }

  function onKeyDown(e) {
    const el = e.currentTarget;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run();
      return;
    }
    // Ctrl+C with nothing selected stops the running command, as in a shell.
    if (e.key === 'c' && e.ctrlKey && !e.metaKey && running && !window.getSelection()?.toString()) {
      e.preventDefault();
      stop();
      return;
    }
    if (e.key === 'l' && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setBlocks([]);
      return;
    }
    // Up and down walk previous commands, but only from the first or last line
    // of the prompt, so they still move the caret inside a multi-line command.
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    if (e.key === 'ArrowUp' && !before.includes('\n') && history.length) {
      e.preventDefault();
      if (histAt === -1) draftRef.current = command;
      const next = Math.min(histAt + 1, history.length - 1);
      setHistAt(next);
      setCommand(history[next]);
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && histAt >= 0) {
      e.preventDefault();
      const next = histAt - 1;
      setHistAt(next);
      setCommand(next >= 0 ? history[next] : draftRef.current);
    }
  }

  // A click on the panel puts the caret in the prompt, unless it ended a text
  // selection (copying output) or landed on a button.
  function onPanelClick(e) {
    if (e.target.closest('button, textarea')) return;
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus({ preventScroll: true });
  }

  const allText = blocks.map((b) => `$ ${b.cmd}\n${blockText(b)}`).join('\n');

  return (
    <div className="terminal-tab">
      <p className="hint">
        {hint || (
          <>Commands run inside <code>/data/apps/{app.slug}</code> as the app's own user, with the app's
          own configuration. Output has secret values masked. Every command is recorded in History.</>
        )}
      </p>

      <div className="tty" onClick={onPanelClick}>
        <div className="tty-bar">
          <span className="tty-title">{title || app?.slug || 'terminal'}</span>
          <span className={`tty-state${running ? ' on' : ''}`}>{running ? 'Running' : 'Ready'}</span>
          <div className="tty-actions">
            {running && <button type="button" className="tty-btn stop" onClick={stop}>Stop</button>}
            <CopyButton text={allText} label="Copy All" />
            <button type="button" className="tty-btn" onClick={() => setBlocks([])} disabled={!blocks.length || running}>Clear</button>
          </div>
        </div>

        <div className="tty-body" ref={bodyRef}>
          {blocks.length === 0 && (
            <div className="tty-idle">{idle || 'Nothing run yet. Try `ls -la` or `cat package.json`.'}</div>
          )}
          {blocks.map((b, i) => (
            <div className="tty-block" key={i}>
              <div className="tty-cmdline">
                <span className="tty-ps" aria-hidden="true">$</span>
                <span className="tty-cmd">{b.cmd}</span>
                {b.done && b.out.length > 0 && <CopyButton text={blockText(b)} />}
              </div>
              {b.out.length > 0 && (
                <pre className="tty-out">
                  {b.out.map((o, j) => <span key={j} className={o.stream === 'stderr' ? 'tty-err' : undefined}>{o.text}</span>)}
                </pre>
              )}
              {b.exit && <div className={`tty-exit${b.exit.bad ? ' bad' : ''}`}>{b.exit.text}</div>}
            </div>
          ))}

          <div className={`tty-prompt${running ? ' busy' : ''}`}>
            <span className="tty-ps" aria-hidden="true">$</span>
            <textarea
              ref={inputRef}
              rows={1}
              value={command}
              onChange={(e) => { setCommand(e.target.value); setHistAt(-1); }}
              onKeyDown={onKeyDown}
              placeholder={running ? 'Running… Ctrl+C or Stop to end it' : ''}
              readOnly={running}
              aria-label="Command"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
            />
          </div>
        </div>

        <div className="tty-keys">
          <span><kbd>Enter</kbd> Run</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> New Line</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> History</span>
          <span><kbd>Ctrl</kbd>+<kbd>C</kbd> Stop</span>
          <span><kbd>Ctrl</kbd>+<kbd>L</kbd> Clear</span>
        </div>
      </div>
    </div>
  );
}
