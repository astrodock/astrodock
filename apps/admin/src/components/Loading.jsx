// Loading states that look like what is coming.
//
// Pages either said "Loading…" in grey text or, worse, rendered an empty state
// first and then popped the real content in — so a page with apps on it flashed
// "No Apps Yet" on every visit, which reads as data loss rather than as latency.
//
// A skeleton in the shape of the eventual content avoids both: nothing claims
// there is nothing, and the layout does not jump when the data lands.

export function SkeletonRows({ rows = 4, cols = 4 }) {
  return (
    <div className="skeleton-table" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton-head">
        {Array.from({ length: cols }, (_, i) => <span key={i} className="sk sk-th" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <span key={c} className={`sk ${c === 0 ? 'sk-strong' : ''}`}
              style={{ width: `${[70, 45, 55, 35, 50][c % 5]}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3 }) {
  return (
    <div className="skeleton-cards" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <span className="sk sk-strong" style={{ width: '45%' }} />
          <span className="sk" style={{ width: '75%' }} />
          <span className="sk" style={{ width: '30%' }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonPanel({ lines = 3 }) {
  return (
    <div className="skeleton-panel" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="sk" style={{ width: `${[60, 80, 40][i % 3]}%` }} />
      ))}
    </div>
  );
}

// For the moment between "something went wrong" and "there is genuinely nothing":
// an error is not an empty state, and should not be dressed as one.
export function LoadError({ message, onRetry }) {
  return (
    <div className="load-error">
      <b>That didn’t load.</b>
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Try Again</button>}
    </div>
  );
}
