import { useNavigate, useLocation } from 'react-router-dom';

// The dashboard previously redirected any unknown path straight to Overview, so a
// mistyped or stale URL silently pretended to work. Saying so is more useful, and
// keeps the address visible in case it was a bookmark worth fixing.

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="notfound">
      <div>
        <div className="logo-mark mark">
          <svg viewBox="0 0 34 34" fill="none" aria-hidden="true">
            <circle cx="17" cy="17" r="15" stroke="var(--accent)" strokeWidth="1.4" opacity=".35" />
            <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" strokeWidth="1.4" opacity=".7" />
            <circle cx="17" cy="17" r="3.6" fill="var(--accent)" />
            <g className="orbit-dot"><circle cx="32" cy="17" r="2.3" fill="var(--text-3)" /></g>
          </svg>
        </div>
        <div className="code">Error 404</div>
        <h1>Nothing At This Address</h1>
        <p>
          There is no page at <code>{pathname}</code>. It may have moved, or the link that brought
          you here may be out of date.
        </p>
        <div className="actions" style={{ display: 'flex', gap: 9, justifyContent: 'center' }}>
          <button onClick={() => navigate(-1)}>Go Back</button>
          <button className="primary" onClick={() => navigate('/overview')}>Overview</button>
        </div>
      </div>
    </div>
  );
}
