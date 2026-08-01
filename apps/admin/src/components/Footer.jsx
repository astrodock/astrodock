import { Link } from 'react-router-dom';

// Every page just stopped. No floor under the content, and nothing saying what
// you are running or where the documentation is — so the version was only
// discoverable by going to Settings and looking for it.

export default function Footer({ version, baseDomain }) {
  return (
    <footer className="app-footer">
      <span>Astrodock{version ? ` ${String(version).replace(/^v/, '')}` : ''}</span>
      {baseDomain && (
        <>
          <span className="sep">·</span>
          <span>{baseDomain}</span>
        </>
      )}
      <span className="right">
        <Link to="/settings">Settings</Link>
        <a href="https://github.com/astrodock/astrodock" target="_blank" rel="noopener">Source</a>
        <a href="https://astrodock.github.io/astrodock/" target="_blank" rel="noopener">Docs</a>
      </span>
    </footer>
  );
}
