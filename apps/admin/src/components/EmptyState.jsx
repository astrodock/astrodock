// An empty list should explain itself.
//
// A table with no rows looks identical to one that failed to load, so every list
// in the dashboard says what would go here and how to start.

const ICONS = {
  // Bow at the top-right, blade running down-left to two teeth. The previous
  // path doubled back on itself and rendered as a blob.
  key: <>
    <circle cx="15.8" cy="8.2" r="4.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12.8 11.2 4.6 19.4v2h3v-2h2v-2h2v-1.9l1.2-1.2"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  apps: <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
  </>,
  users: <>
    <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 20c0-3.6 3.4-6.2 7.5-6.2s7.5 2.6 7.5 6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  pages: <>
    <path d="M6 3h7l5 5v13H6V3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M13 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  domains: <>
    <path d="M9.9 14.1a3.9 3.9 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M14.1 9.9a3.9 3.9 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  activity: <path d="M3 12h3l3-6 5 12 3-6h4" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" />,
  deploy: <>
    <path d="M12 3c3.4 2.4 5.2 6 5.2 10.2L12 18l-5.2-4.8C6.8 9 8.6 5.4 12 3z"
      stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="12" cy="9.6" r="1.9" stroke="currentColor" strokeWidth="1.4" />
    <path d="M9.4 18.4 8 21.4M14.6 18.4 16 21.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  logs: <>
    <rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 9.5h6M7 13h10M7 16.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  file: <>
    <path d="M5 3.5h8l6 6V20.5H5V3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M13 3.5v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </>,
  settings: <>
    <circle cx="12" cy="12" r="2.9" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12 2.6v2.5M12 18.9v2.5M2.6 12h2.5M18.9 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
  health: <path d="M2.6 12.5h4l2-5.4 3.6 10.8 2.4-7 1.6 3.2h5.2"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  env: <>
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="m7.6 10 2.4 2.4-2.4 2.4M12.8 15.2h3.8" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" />
  </>,
  search: <>
    <circle cx="11" cy="11" r="6.4" stroke="currentColor" strokeWidth="1.6" />
    <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </>
};

export default function EmptyState({ icon = 'search', title, body, action }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICONS[icon] || ICONS.search}</svg>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}
