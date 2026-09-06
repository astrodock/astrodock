// A terminal for one app.
//
// Command-and-stream, not a pty: you type a command, output arrives as it is
// produced, and you get the exit code. No vim, no top, no interactive prompts.
// That is what an outage actually needs, and it avoids a native dependency in
// the runner image.
//
// It only appears when the platform has ASTRODOCK_ENABLE_TERMINAL=true and the
// caller holds `exec`, which no key preset grants and the operator role does
// not carry. Every command is written to the audit trail before it runs, and
// shows up in this app's History tab.

import { useState, useRef, useEffect } from 'react';
import * as api from '../lib/api';

const MAX_LINES = 2000;

export default function TerminalTab({ app }) {
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [histAt, setHistAt] = useState(-1);
  const outRef = useRef(null);
  const abortRef = useRef(null);

  // Follow the tail only when already at it, so reading scrollback is not
  // yanked away by output still arriving.
  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const atTail = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atTail) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function push(stream, text) {
    setLines((prev) => [...prev, { stream, text }].slice(-MAX_LINES));
  }

  async function run(e) {
    e?.preventDefault();
    const cmd = command.trim();
    if (!cmd || running) return;

    setHistory((h) => (h[0] === cmd ? h : [cmd, ...h].slice(0, 50)));
    setHistAt(-1);
    push('cmd', `$ ${cmd}`);
    setCommand('');
    setRunning(true);

    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      await api.execStream(app.slug, cmd, ctl.signal, (event, data) => {
        if (event === 'stdout' || event === 'stderr') push(event, data);
        else if (event === 'exit') {
          push('exit', data.timedOut
            ? 'timed out after 5 minutes'
            : `exit ${data.code ?? ''}${data.signal ? ` (${data.signal})` : ''}`.trim());
        } else if (event === 'error') push('stderr', String(data));
      });
    } catch (err) {
      if (err.name !== 'AbortError') push('stderr', err.message);
    }
    setRunning(false);
    abortRef.current = null;
  }

  function stop() {
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
  }

  // Up and down walk previous commands, which is the one shell affordance worth
  // having when the thing you are debugging needs the same command twice.
  function onKeyDown(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(histAt + 1, history.length - 1);
      if (next >= 0) { setHistAt(next); setCommand(history[next]); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = histAt - 1;
      setHistAt(next);
      setCommand(next >= 0 ? history[next] : '');
    }
  }

  return (
    <div className="terminal-tab">
      <p className="hint">
        Commands run inside <code>/data/apps/{app.slug}</code> as the app's own user, with the app's
        own configuration. Output has secret values masked. Every command is recorded in History.
      </p>

      <pre className="log-viewer terminal-out" ref={outRef}>
        {lines.length === 0
          ? <span className="term-idle">Nothing run yet. Try `ls -la` or `cat package.json`.</span>
          : lines.map((l, i) => <span key={i} className={`term-${l.stream}`}>{l.text}</span>)}
      </pre>

      <form className="terminal-input" onSubmit={run}>
        <span className="term-prompt">$</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? 'Running…' : 'Type a command and press Enter'}
          disabled={running}
          autoComplete="off"
          spellCheck="false"
        />
        {running
          ? <button type="button" className="danger" onClick={stop}>Stop</button>
          : <button type="submit" disabled={!command.trim()}>Run</button>}
        {lines.length > 0 && !running && (
          <button type="button" onClick={() => setLines([])}>Clear</button>
        )}
      </form>
    </div>
  );
}
