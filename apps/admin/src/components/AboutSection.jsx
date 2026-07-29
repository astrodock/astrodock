import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import UpdateModal from './UpdateModal';
import ReauthModal from './ReauthModal';

// Version, and whether there is a newer one.
//
// Astrodock never updates itself unprompted — but it will update on request.
// The button asks you to confirm who you are, takes a backup, replaces the
// stack, and puts the previous version back if the new one does not come up.
//
// The command is still here for anyone who would rather do it themselves, or
// whose install cannot be updated this way (a source build, or anything not
// started by Compose).

const COMMAND = 'docker compose pull && docker compose up -d';

function Row({ label, children }) {
  return (
    <div className="field">
      <div className="lab"><b>{label}</b></div>
      <div className="ctl">{children}</div>
    </div>
  );
}

export default function AboutSection({ diagnostics }) {
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canUpdate, setCanUpdate] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [reauth, setReauth] = useState(null);

  const load = (force) => {
    setChecking(true);
    api.getVersion(force).then(setInfo).catch(() => setInfo(null)).finally(() => setChecking(false));
  };
  useEffect(() => { load(false); }, []);
  useEffect(() => { api.describeUpdate().then(setCanUpdate).catch(() => setCanUpdate({ ok: false })); }, []);

  const current = info?.current?.version || diagnostics?.version;
  const fromSource = info?.current?.source === 'source' || diagnostics?.build === 'from source';

  const state = info?.status;
  const tone = state === 'behind' ? 'warn' : state === 'current' ? 'ok' : '';

  return (
    <section className="set-section">
      <div className="sec-head">
        <div>
          <h2>About This Astrodock</h2>
          <p>Which version is running, and whether a newer one has been released.</p>
        </div>
        <div className="sec-actions">
          <button type="button" onClick={() => load(true)} disabled={checking || state === 'disabled'}>
            {checking ? 'Checking…' : 'Check Now'}
          </button>
        </div>
      </div>

      {state === 'behind' && (
        <div className="rcard warn" style={{ marginBottom: 12 }}>
          <span className="led warn" />
          <span>
            <b>{info.latest} is available.</b> You are on {String(current).replace(/^v/, '')}.{' '}
            <a className="link" href={info.url} target="_blank" rel="noopener">See what changed ↗</a>
          </span>
          {canUpdate?.ok && (
            <button className="primary" style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => setUpdating(true)}>Update Now</button>
          )}
        </div>
      )}

      {state === 'behind' && canUpdate && !canUpdate.ok && canUpdate.reason && (
        <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Astrodock cannot update this install for you: {canUpdate.reason}
        </p>
      )}

      <div className="field-panel">
        <Row label="Version">
          <code className="mono">{current ? String(current).replace(/^v/, '') : 'unknown'}</code>
          {state && <span className={`chip ${tone}`}>{
            state === 'behind' ? 'update available'
              : state === 'current' ? 'up to date'
                : state === 'disabled' ? 'checking off'
                  : state === 'error' ? 'check failed' : 'unknown'
          }</span>}
        </Row>

        <Row label="Build">
          <span className="text-muted">
            {fromSource
              ? 'Built from source — the version above is the release this tree descends from, not necessarily what it contains.'
              : diagnostics?.build || 'image'}
          </span>
        </Row>

        {info?.cachedAt && state !== 'disabled' && (
          <Row label="Last Checked">
            <span className="text-muted">{new Date(info.cachedAt).toLocaleString()}</span>
          </Row>
        )}
      </div>

      {(state === 'behind' || state === 'current') && (
        <div className="opt-group" style={{ marginTop: 18 }}>
          <header>
            <h4>{canUpdate?.ok ? 'Or Update From The Server' : 'How To Update'}</h4>
            <p>
              Run this on the server, in the directory holding your{' '}
              <code>docker-compose.yml</code>. Astrodock applies its own database
              migrations on the way up, and your data lives in volumes the update
              does not touch.
            </p>
          </header>
          <div className="cmdline">
            <code>{COMMAND}</code>
            <button type="button" onClick={() => {
              navigator.clipboard.writeText(COMMAND); setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Take a backup first if you want a way back — Settings → Backups, or the
            update is not reversible without one.
          </p>
        </div>
      )}

      {state === 'error' && (
        <p className="hint" style={{ marginTop: 10 }}>
          {info.message} This does not affect anything else; it only means the version
          comparison is unavailable right now.
        </p>
      )}
      {state === 'disabled' && (
        <p className="hint" style={{ marginTop: 10 }}>
          Update checking is switched off under Logs &amp; Privacy, so Astrodock is not
          contacting GitHub. You can still update with the command above.
        </p>
      )}
      {updating && (
        <UpdateModal
          current={current}
          latest={info?.latest}
          onClose={() => setUpdating(false)}
          onDone={(_res, err) => {
            setUpdating(false);
            if (err) setReauth({ retry: () => setUpdating(true) });
          }}
        />
      )}

      {reauth && (
        <ReauthModal
          action="Updating Astrodock"
          onConfirm={() => { const again = reauth.retry; setReauth(null); again(); }}
          onCancel={() => setReauth(null)}
        />
      )}
    </section>
  );
}
