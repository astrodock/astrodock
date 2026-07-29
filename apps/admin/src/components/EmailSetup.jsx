import { useState, useEffect } from 'react';
import * as api from '../lib/api';

// Setting up email delivery.
//
// Two providers on purpose. Resend is one pasted key and nothing to understand,
// which is what you want at 11pm on a fresh box. SMTP is every other service
// there has ever been — SES, Postmark, Mailgun, Fastmail, Gmail, a relay at
// work — behind one form, rather than an adapter per vendor.
//
// Credentials are write-only: the server stores them encrypted and never sends
// them back, so a blank password field means "keep what you have", never "erase
// it". Anything else would wipe the key each time someone edited the port.

const PROVIDERS = [
  { key: 'none', label: 'None', blurb: 'No email is sent. Alerts still show in the dashboard.' },
  { key: 'resend', label: 'Resend', blurb: 'Paste an API key from resend.com. Nothing else to configure.' },
  { key: 'smtp', label: 'SMTP', blurb: 'Works with any mail service — SES, Postmark, Mailgun, Fastmail, Gmail, or your own relay.' }
];

// The hosts people actually reach for, so nobody has to go hunting for a port.
const PRESETS = [
  { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587 },
  { label: 'Postmark', host: 'smtp.postmarkapp.com', port: 587 },
  { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587 },
  { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587 },
  { label: 'Fastmail', host: 'smtp.fastmail.com', port: 465 },
  { label: 'Gmail', host: 'smtp.gmail.com', port: 587 }
];

export default function EmailSetup({ initial, onSaved, compact = false, testTo = '' }) {
  const [cfg, setCfg] = useState(initial || null);
  const [provider, setProvider] = useState(initial?.provider || 'none');
  const [from, setFrom] = useState(initial?.from || '');
  const [resendKey, setResendKey] = useState('');
  const [smtp, setSmtp] = useState(() => ({
    host: initial?.smtp?.host || '', port: initial?.smtp?.port || 587,
    secure: !!initial?.smtp?.secure, user: initial?.smtp?.user || '', password: ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [testAddr, setTestAddr] = useState(testTo);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (initial) return;
    api.getEmailConfig().then((d) => {
      setCfg(d); setProvider(d.provider); setFrom(d.from || '');
      setSmtp({ host: d.smtp.host || '', port: d.smtp.port || 587, secure: !!d.smtp.secure, user: d.smtp.user || '', password: '' });
    }).catch((e) => setError(e.message));
  }, [initial]);

  const dirty = cfg && (
    provider !== cfg.provider || from !== (cfg.from || '') || !!resendKey || !!smtp.password
    || smtp.host !== (cfg.smtp.host || '') || Number(smtp.port) !== cfg.smtp.port
    || smtp.secure !== !!cfg.smtp.secure || smtp.user !== (cfg.smtp.user || '')
  );

  async function save() {
    setSaving(true); setError(''); setNote('');
    try {
      const next = await api.updateEmailConfig({
        provider, from,
        ...(resendKey ? { resendApiKey: resendKey } : {}),
        smtp: { host: smtp.host, port: Number(smtp.port), secure: smtp.secure, user: smtp.user, ...(smtp.password ? { password: smtp.password } : {}) }
      });
      setCfg(next); setResendKey(''); setSmtp((s) => ({ ...s, password: '' }));
      setNote('Saved.'); onSaved?.(next);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setError(''); setNote('');
    try {
      const r = await api.sendTestEmail(testAddr.trim());
      setNote(`Test sent to ${r.to} via ${r.provider}. If it does not arrive, check the spam folder and that the “from” address is one your provider allows.`);
    } catch (err) { setError(err.message); } finally { setTesting(false); }
  }

  // A failed load used to sit on "Loading…" forever: the error was stored but the
  // guard below returned before anything could render it, so every failure looked
  // identical to a slow network and told you nothing.
  if (!cfg) {
    return error ? (
      <>
        <div className="error">{error}</div>
        <button type="button" onClick={() => {
          setError('');
          api.getEmailConfig().then((d) => {
            setCfg(d); setProvider(d.provider); setFrom(d.from || '');
            setSmtp({ host: d.smtp.host || '', port: d.smtp.port || 587, secure: !!d.smtp.secure, user: d.smtp.user || '', password: '' });
          }).catch((e) => setError(e.message));
        }}>Try Again</button>
      </>
    ) : <p className="hint">Loading…</p>;
  }

  const chosen = PROVIDERS.find((p) => p.key === provider);

  return (
    <div className="email-setup">
      {error && <div className="error">{error}</div>}
      {note && <div className="rcard ok" style={{ marginBottom: 12 }}><span className="led ok" /><span>{note}</span></div>}

      {cfg.fromEnv && cfg.provider === 'resend' && !cfg.resend.keySet && (
        <div className="rcard warn" style={{ marginBottom: 12 }}>
          <span className="led warn" />
          <span>The Resend key currently in use came from the environment at install. Saving here stores it in the database instead, encrypted.</span>
        </div>
      )}

      <div className="opt-group">
        <header><h4>Provider</h4></header>
        <div className="seg seg-fit">
          {PROVIDERS.map((p) => (
            <button type="button" key={p.key} className={provider === p.key ? 'sel' : ''}
              onClick={() => setProvider(p.key)}>{p.label}</button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 7 }}>{chosen?.blurb}</p>
      </div>

      {provider !== 'none' && (
        <label>
          Send From
          <input value={from} onChange={(e) => setFrom(e.target.value)}
            placeholder="Astrodock &lt;alerts@yourdomain.com&gt;" />
          <span className="hint">Must be an address your provider is allowed to send as — usually a domain you have verified with them.</span>
        </label>
      )}

      {provider === 'resend' && (
        <label>
          API Key
          <input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)}
            autoComplete="off"
            placeholder={cfg.resend.keySet ? '•••••••• (stored — leave blank to keep it)' : 're_...'} />
          <span className="hint">From the API Keys page at resend.com. Stored encrypted; never shown again.</span>
        </label>
      )}

      {provider === 'smtp' && (
        <>
          {!compact && (
            <div className="opt-group">
              <header><h4>Common Services</h4><p>Fills in the host and port. You still supply the credentials.</p></header>
              <div className="seg-pills">
                {PRESETS.map((p) => (
                  <button type="button" key={p.label} className={`pillbtn ${smtp.host === p.host ? 'sel' : ''}`}
                    onClick={() => setSmtp((s) => ({ ...s, host: p.host, port: p.port, secure: p.port === 465 }))}>{p.label}</button>
                ))}
              </div>
            </div>
          )}

          <div className="row-2">
            <label style={{ flex: 2 }}>
              Server
              <input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" />
            </label>
            <label style={{ flex: 1 }}>
              Port
              <input type="number" value={smtp.port}
                onChange={(e) => setSmtp({ ...smtp, port: e.target.value, secure: Number(e.target.value) === 465 })} />
            </label>
          </div>

          <div className="opt-list" style={{ marginBottom: '1.1rem' }}>
            <div className={`opt-row ${smtp.secure ? 'on' : ''}`}>
              <span className="name">
                Connect over TLS immediately
                <span className="info" data-tip="Port 465 expects an encrypted connection from the first byte. Ports 587 and 25 start in the clear and upgrade with STARTTLS, which Astrodock does automatically — leave this off for those.">i</span>
              </span>
              <span className={`mini-toggle ${smtp.secure ? 'on' : ''}`} role="switch" aria-checked={smtp.secure}
                aria-label="Connect over TLS immediately"
                onClick={() => setSmtp({ ...smtp, secure: !smtp.secure })} />
            </div>
          </div>

          <div className="row-2">
            <label>
              Username
              <input value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} autoComplete="off" />
            </label>
            <label>
              Password
              <input type="password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                autoComplete="new-password"
                placeholder={cfg.smtp.passwordSet ? '•••••••• (stored — leave blank to keep it)' : ''} />
            </label>
          </div>
          <p className="hint" style={{ marginTop: '-.6rem' }}>
            Leave both blank for a relay that does not require authentication.
          </p>
        </>
      )}

      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {cfg.usable && (
        <div className="opt-group" style={{ marginTop: 22 }}>
          <header>
            <h4>Send a Test</h4>
            <p>The only way to know a mail setup works is to make it deliver something.</p>
          </header>
          <div className="row-2" style={{ alignItems: 'flex-end' }}>
            <label style={{ flex: 2, marginBottom: 0 }}>
              <input value={testAddr} onChange={(e) => setTestAddr(e.target.value)} placeholder="you@example.com" />
            </label>
            <button type="button" onClick={test} disabled={testing || !testAddr.trim()}>
              {testing ? 'Sending…' : 'Send Test'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
