import { useState, useRef, useEffect, useCallback } from 'react';
import { getToken, TOKEN_KEY } from '../lib/api';

export default function TerminalTab({ app }) {
  const [input, setInput] = useState('');
  const [lines, setLines] = useState([]);
  const [running, setRunning] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);

  // Auto-scroll to bottom when output updates
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input on mount and tab switch
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runCommand = useCallback(async (command) => {
    if (!command.trim() || running) return;

    // Add to history
    historyRef.current = [command, ...historyRef.current.filter(h => h !== command)].slice(0, 50);
    historyIndexRef.current = -1;

    // Show the command in output
    setLines(prev => [...prev, { type: 'command', text: command }]);
    setInput('');
    setRunning(true);

    const token = getToken();
    const params = new URLSearchParams({ command });
    const url = `/admin/apps/${app.slug}/exec?${params}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        window.location.href = '/login';
        return;
      }

      if (response.status === 404) {
        setDisabled(true);
        setLines(prev => [...prev, {
          type: 'stderr',
          text: 'Terminal is disabled on this server. Set ASTRODOCK_ENABLE_TERMINAL=true to enable it.'
        }]);
        setRunning(false);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setLines(prev => [...prev, { type: 'stderr', text: data.error || 'Request failed' }]);
        setRunning(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const eventBlocks = buffer.split('\n\n');
        // Keep the last chunk as it may be incomplete
        buffer = eventBlocks.pop() || '';

        for (const block of eventBlocks) {
          if (!block.trim()) continue;

          let event = '';
          let data = '';

          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }

          if (!event || !data) continue;

          try {
            const parsed = JSON.parse(data);

            if (event === 'stdout') {
              setLines(prev => [...prev, { type: 'stdout', text: parsed }]);
            } else if (event === 'stderr') {
              setLines(prev => [...prev, { type: 'stderr', text: parsed }]);
            } else if (event === 'exit') {
              const code = parsed.code;
              if (code !== 0) {
                setLines(prev => [...prev, { type: 'exit', text: `Process exited with code ${code}` }]);
              }
            } else if (event === 'error') {
              setLines(prev => [...prev, { type: 'stderr', text: parsed }]);
            }
          } catch { /* ignore malformed data */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLines(prev => [...prev, { type: 'stderr', text: `Connection error: ${err.message}` }]);
      }
    }

    setRunning(false);
    // Re-focus input after command completes
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [app.slug, running]);

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const history = historyRef.current;
      if (history.length === 0) return;
      const next = Math.min(historyIndexRef.current + 1, history.length - 1);
      historyIndexRef.current = next;
      setInput(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const history = historyRef.current;
      const next = historyIndexRef.current - 1;
      if (next < 0) {
        historyIndexRef.current = -1;
        setInput('');
      } else {
        historyIndexRef.current = next;
        setInput(history[next]);
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      if (running) {
        // Abort is handled by closing the connection on the backend
        // For now just visually indicate cancellation
        setLines(prev => [...prev, { type: 'exit', text: '^C' }]);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  }

  function handleClear() {
    setLines([]);
    inputRef.current?.focus();
  }

  return (
    <div>
      <div className="tab-header">
        <h2>Terminal</h2>
        <div className="log-controls">
          <span className="terminal-cwd">{app.slug}</span>
          <button onClick={handleClear}>Clear</button>
        </div>
      </div>
      <p className="hint">Run shell commands inside this app’s container — handy for one-off jobs like database migrations or seeds, and quick debugging. <b style={{ color: 'var(--warning)' }}>Whatever you type runs live on the server</b>, so take care.</p>

      {/* Output area */}
      <div className="terminal-output" ref={outputRef} onClick={() => inputRef.current?.focus()}>
        {lines.length === 0 && (
          <div className="terminal-welcome">
            Run commands in the app directory. Try: <code>ls</code>, <code>node -e "console.log('hi')"</code>, <code>npm run seed</code>
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`terminal-line terminal-${line.type}`}>
            {line.type === 'command' ? (
              <><span className="terminal-prompt">$</span> {line.text}</>
            ) : (
              line.text
            )}
          </div>
        ))}
        {running && <div className="terminal-cursor" />}
      </div>

      {/* Input area */}
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          className="terminal-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Terminal disabled on this server' : running ? 'Running...' : 'Enter command...'}
          disabled={running || disabled}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
