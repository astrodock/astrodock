import { useState, useEffect } from 'react';
import EmailSetup from '../components/EmailSetup';
import { claimAdmin, checkSetupDns, setSetupDomain, deferSetupDomain, getDnsProviders, createDnsRecord, login, setToken } from '../lib/api';
import Select from '../components/Select';

// First-run setup. This is what replaces hand-editing .env before the first boot:
// the stack comes up with no domain and no administrator, serves this page over
// http://<server-ip>, and the operator finishes here.
//
// Two steps, in this order for a reason — claiming the admin account first means
// the domain step can be protected by ordinary admin auth rather than by the
// setup token, so the token is used exactly once and never for anything else.

// The A-record value to show. ASTRODOCK_PUBLIC_IP wins if the operator set it;
// otherwise the address in the URL bar IS this server's public IP, since that is
// how the operator reached the page. No "what is my IP" service involved.
function serverAddress(publicIp) {
  if (publicIp) return publicIp;
  const h = window.location.hostname;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  const isIpv6 = h.includes(':');
  return isIpv4 || isIpv6 ? h : '';
}

// What to type, per registrar. The Name field and the provider-specific trap are
// the two things that actually go wrong; everything else is the same everywhere.
const REGISTRARS = [
  {
    key: 'cloudflare', label: 'Cloudflare',
    where: 'DNS → Records → Add record',
    fields: [['Type', 'A'], ['Name', '{NAME}'], ['IPv4 address', '{IP}'], ['Proxy status', 'DNS only (grey cloud)']],
    warning: 'Turn the proxy OFF. An orange-cloud record terminates HTTPS at Cloudflare, so Astrodock can never get a certificate for your domain.'
  },
  {
    key: 'digitalocean', label: 'DigitalOcean',
    where: 'Networking → Domains → your domain',
    fields: [['Type', 'A'], ['Hostname', '{NAME}'], ['Will direct to', '{IP}'], ['TTL', '300']],
    warning: 'Your registrar must point its nameservers at DigitalOcean, or this zone is ignored entirely.'
  },
  {
    key: 'namecheap', label: 'Namecheap',
    where: 'Domain List → Manage → Advanced DNS → Add New Record',
    fields: [['Type', 'A Record'], ['Host', '{NAME}'], ['Value', '{IP}'], ['TTL', 'Automatic']],
    warning: 'The domain must be on Namecheap BasicDNS. URL forwarding silently overrides A records.'
  },
  {
    key: 'godaddy', label: 'GoDaddy',
    where: 'My Products → DNS → Add New Record',
    fields: [['Type', 'A'], ['Name', '{NAME}'], ['Value', '{IP}'], ['TTL', '600 seconds']],
    warning: 'Remove any parked or forwarding record for the same name first, or it wins.'
  },
  {
    key: 'route53', label: 'AWS Route 53',
    where: 'Hosted zones → your zone → Create record',
    fields: [['Record name', '{NAME}'], ['Record type', 'A'], ['Value', '{IP}'], ['TTL', '300']],
    warning: 'Route 53 shows the full name as {NAME}.{DOMAIN} — that is the same record, not a duplicated prefix.'
  },
  {
    key: 'other', label: 'Something else',
    where: 'Your DNS provider, wherever records are managed',
    fields: [['Type', 'A'], ['Name / Host', '{NAME}'], ['Value / Points to', '{IP}']],
    warning: 'If there is a "forwarding" or "parking" feature switched on for this domain, turn it off — those override A records.'
  }
];

function Stepper({ step, needsClaim }) {
  const steps = needsClaim ? ['Administrator', 'Email', 'Domain & HTTPS'] : ['Email', 'Domain & HTTPS'];
  const offset = needsClaim ? 0 : 1;
  return (
    <div className="setup-steps">
      {steps.map((label, i) => {
        const n = i + 1 + offset;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <div key={label} className={`setup-step ${state}`}>
            <span className="setup-step-num">{state === 'done' ? '✓' : n - offset}</span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function SetupPage({ status }) {
  const needsClaim = status.needsClaim;
  const [step, setStep] = useState(needsClaim ? 1 : 2);   // 1 claim · 2 email · 3 domain
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Step 1 — claim
  const [setupToken, setSetupToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  // Step 2 — domain
  const [baseDomain, setBaseDomain] = useState(status.baseDomain || '');
  const [tlsMode, setTlsMode] = useState(status.tlsMode === 'off' ? 'off' : 'auto');
  const [acmeEmail, setAcmeEmail] = useState(status.acmeEmail || '');
  const [dns, setDns] = useState(null);
  const [done, setDone] = useState(null);
  // `done` is the handoff payload; `finished` is whether we are showing it yet.
  // Email sits between the two — the box still answers on this address until the
  // operator follows the link, so it is the last quiet moment to set it up.
  const [finished, setFinished] = useState(false);

  // Optional "create the record for me" path.
  const [providers, setProviders] = useState([]);
  const [autoDns, setAutoDns] = useState(false);
  const [dnsProvider, setDnsProvider] = useState('digitalocean');
  const [dnsToken, setDnsToken] = useState('');
  const [dnsCreated, setDnsCreated] = useState(null);
  // null = no registrar picked; the generic record above is usually enough.
  const [registrar, setRegistrar] = useState(null);

  useEffect(() => {
    // Needs admin auth, so only once we are past the claim step.
    if (step !== 2) return;
    getDnsProviders()
      .then((d) => { setProviders(d.providers || []); if (d.providers?.[0]) setDnsProvider(d.providers[0].key); })
      .catch(() => setProviders([]));
  }, [step]);

  const ip = serverAddress(status.publicIp);

  async function handleClaim(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await claimAdmin(setupToken.trim(), email, password, 'Admin');
      // Sign straight in with the credentials just created, so the domain step is
      // authenticated normally and the operator never sees a login screen mid-flow.
      const data = await login(email, password);
      setToken(data.token);
      if (!acmeEmail) setAcmeEmail(email);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckDns() {
    setError(''); setBusy(true); setDns(null);
    try {
      setDns(await checkSetupDns(baseDomain.trim(), ip));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDefer() {
    setError(''); setBusy(true);
    try {
      await deferSetupDomain();
      // Full reload rather than a route change: App.jsx decides between the wizard
      // and the dashboard from /setup/status at mount, so it has to ask again.
      window.location.assign('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function handleCreateDns() {
    setError(''); setBusy(true); setDnsCreated(null);
    try {
      const r = await createDnsRecord(dnsProvider, dnsToken.trim(), baseDomain.trim(), ip);
      setDnsCreated(r);
      setDnsToken(''); // spent — do not keep it sitting in component state
      setDns(await checkSetupDns(baseDomain.trim(), ip));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDomain(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      setDone(await setSetupDomain(baseDomain.trim(), tlsMode, acmeEmail.trim()));
      setFinished(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <div className="setup-card">
        <div className="login-logo">
          <div className="logo-mark">
            <svg width="38" height="38" viewBox="0 0 34 34" fill="none">
              <circle cx="17" cy="17" r="15" stroke="var(--accent)" strokeWidth="1.4" opacity=".4"/>
              <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" strokeWidth="1.4" opacity=".7"/>
              <circle cx="17" cy="17" r="3.6" fill="var(--accent)"/>
              <g className="orbit-dot"><circle cx="32" cy="17" r="2.3" fill="var(--text)"/></g>
            </svg>
          </div>
          <span className="logo-text-lg">Astrodock</span>
        </div>
        <p className="login-subtitle">Set up your platform</p>

        {!finished && <Stepper step={step} needsClaim={needsClaim} />}
        {error && <div className="error">{error}</div>}

        {/* ── done ─────────────────────────────────────────────────────────── */}
        {finished && done && (
          <div className="setup-body">
            <div className="callout ok">
              <b>That's it — Astrodock is configured.</b>
              <p>
                Your dashboard has moved to its real address. This page, on the server's IP,
                stops being the way in.
              </p>
            </div>
            <a className="login-btn"
               href={done.handoff ? `${done.adminUrl}/#handoff=${done.handoff}` : done.adminUrl}
               style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Go to {done.adminUrl}
            </a>
            {tlsMode === 'auto' && (
              <p className="field-help" style={{ marginTop: 12 }}>
                The certificate is issued on your first visit, so the very first load can take a few
                seconds. If you see a warning, wait a moment and reload — that is the certificate
                still being fetched, not a misconfiguration.
              </p>
            )}
            {!done.routed && (
              <p className="field-help">
                Routing hasn't reloaded yet. It retries automatically, so give it a minute before
                worrying.
              </p>
            )}
          </div>
        )}

        {/* ── step 1: claim the administrator ──────────────────────────────── */}
        {!finished && step === 1 && (
          <form className="setup-body" onSubmit={handleClaim} noValidate>
            <div className="callout">
              <b>First, prove this server is yours.</b>
              {status.tokenSource === 'preset' ? (
                <>
                  <p>
                    This server is currently unclaimed — anyone who reached this page before you
                    could otherwise make themselves the administrator. The token proves you are the
                    person who set the server up.
                  </p>
                  <p>
                    Enter the one you chose when you installed Astrodock, in your server's startup
                    script. It is used once, right now, and stops working the moment your account
                    exists.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    This server is currently unclaimed — anyone who reached this page before you
                    could otherwise make themselves the administrator. The token proves you are the
                    person who set the server up, by proving you can read its logs.
                  </p>
                  <p>Astrodock printed one when it started. Fetch it over SSH with:</p>
                  <code className="setup-cmd">
                    cd /opt/astrodock && docker compose logs api | grep -A2 'first-run setup'
                  </code>
                  <p style={{ marginTop: 8 }}>
                    Next time, you can skip this: set <code>ASTRODOCK_SETUP_TOKEN</code> to a token
                    of your own when you install, and there's nothing to look up.
                  </p>
                </>
              )}
            </div>
            <label>
              Setup Token
              <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)}
                required autoFocus spellCheck="false"
                placeholder={status.tokenSource === 'preset' ? 'The token you chose at install time' : 'Paste the token from the log'} />
            </label>
            <label>
              Your Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                required placeholder="you@example.com" />
              <span className="field-help">This becomes the administrator sign-in for the dashboard.</span>
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                required minLength={8} placeholder="At least 8 characters" />
            </label>
            <label>
              Confirm Password
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                required minLength={8} placeholder="Type it again" />
            </label>
            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? 'Creating…' : 'Create administrator'}
            </button>
          </form>
        )}

        {/* ── step 2: domain + HTTPS ───────────────────────────────────────── */}
        {!finished && step === 3 && (
          <form className="setup-body" onSubmit={handleSaveDomain} noValidate>
            <div className="callout">
              <b>Where should your apps live?</b>
              <p>
                Pick a domain you control. Every app you deploy gets its own name under it —
                an app called <code>invoices</code> would be served at{' '}
                <code>invoices.{baseDomain || 'your-domain.com'}</code>, and this dashboard moves to{' '}
                <code>{status.adminSubdomain}.{baseDomain || 'your-domain.com'}</code>.
              </p>
            </div>

            <label>
              Base Domain
              <input value={baseDomain} onChange={(e) => { setBaseDomain(e.target.value); setDns(null); }}
                required placeholder="apps.example.com" spellCheck="false" autoFocus />
              <span className="field-help">
                A subdomain like <code>apps.example.com</code> keeps your main website free for
                something else. Using the bare domain works too.
              </span>
            </label>

            {baseDomain.trim().includes('.') && (
              <>
                <p className="setup-section-label">Add this DNS record at your registrar</p>
                <div className="seg-pills" style={{ marginBottom: 10 }}>
                  {REGISTRARS.map((r) => (
                    <button type="button" key={r.key}
                      className={`pillbtn ${registrar === r.key ? 'sel' : ''}`}
                      onClick={() => setRegistrar(registrar === r.key ? null : r.key)}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <div className="dns-rec">
                  <div><span className="rk">Type</span><b>A</b></div>
                  <div><span className="rk">Name</span><span className="rv">*.{baseDomain.trim()}</span></div>
                  <div><span className="rk">Value</span>
                    <span className="rv" style={{ color: 'var(--info)' }}>{ip || '<your server IP>'}</span>
                  </div>
                  <div className="rp">
                    One wildcard record covers this dashboard and every app you will ever deploy —
                    you won't need to touch DNS again.
                  </div>
                </div>
                {registrar && (() => {
                  const r = REGISTRARS.find((x) => x.key === registrar);
                  const name = baseDomain.trim().split('.').length > 2
                    ? `*.${baseDomain.trim().split('.').slice(0, -2).join('.')}`
                    : '*';
                  const fill = (v) => v
                    .replace('{NAME}', name)
                    .replace('{IP}', ip || '<your server IP>')
                    .replace('{DOMAIN}', baseDomain.trim().split('.').slice(-2).join('.'));
                  return (
                    <div className="callout" style={{ marginTop: 10 }}>
                      <b>{r.label}</b>
                      <p style={{ marginBottom: 8 }}>{r.where}</p>
                      <div className="dns-rec" style={{ marginBottom: 8 }}>
                        {r.fields.map(([k, v]) => (
                          <div key={k}>
                            <span className="rk">{k}</span>
                            <span className="rv" style={{ color: 'var(--info)' }}>{fill(v)}</span>
                          </div>
                        ))}
                      </div>
                      <p><b>Watch out:</b> {fill(r.warning)}</p>
                    </div>
                  );
                })()}

                {!ip && (
                  <p className="field-help">
                    Couldn't detect this server's IP from your browser. Use the address you SSH to,
                    or set <code>ASTRODOCK_PUBLIC_IP</code>.
                  </p>
                )}

                <div className="setup-check">
                  <button type="button" className="pillbtn" onClick={handleCheckDns} disabled={busy}>
                    {busy ? 'Checking…' : 'Check DNS'}
                  </button>
                  {providers.length > 0 && !autoDns && (
                    <button type="button" className="link-btn" onClick={() => setAutoDns(true)}>
                      or let Astrodock create it
                    </button>
                  )}
                  {dns && (
                    <span className={`chip ${dns.ok ? 'ok' : 'warn'}`}>
                      {dns.ok ? 'Record is live' : 'Not resolving yet'}
                    </span>
                  )}
                </div>
                {dns && <p className="field-help">{dns.message}</p>}

                {autoDns && (
                  <div className="callout">
                    <b>Create the record for me</b>
                    <p>
                      If your DNS is hosted somewhere with an API, paste a token and Astrodock will add
                      the record above. <strong>The token is used once and never stored</strong> — it
                      isn't saved, logged, or needed again.
                    </p>
                    <label>
                      DNS provider
                      <Select value={dnsProvider} onChange={setDnsProvider}
                        options={providers.map((p) => ({ value: p.key, label: p.label }))} />
                    </label>
                    <label>
                      API token
                      <input type="password" value={dnsToken} spellCheck="false"
                        onChange={(e) => setDnsToken(e.target.value)} placeholder="Paste the token" />
                      <span className="field-help">
                        {providers.find((p) => p.key === dnsProvider)?.tokenHint}
                      </span>
                    </label>
                    <div className="setup-check">
                      <button type="button" className="pillbtn" onClick={handleCreateDns}
                        disabled={busy || !dnsToken.trim()}>
                        {busy ? 'Creating…' : 'Create the record'}
                      </button>
                      <button type="button" className="link-btn" onClick={() => setAutoDns(false)}>
                        I'll add it myself
                      </button>
                    </div>
                    {dnsCreated && (
                      <p className="field-help">
                        Created <code>{dnsCreated.record}</code> in zone <code>{dnsCreated.zone}</code> →{' '}
                        <code>{dnsCreated.ip}</code>. It can take a few minutes to spread — use Check DNS
                        above to confirm.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            <label>
              HTTPS
              <Select value={tlsMode} onChange={setTlsMode} options={[
                { value: 'auto', label: 'Automatic', description: 'A free, real certificate from Let\u2019s Encrypt. What you want for a public server.' },
                { value: 'internal', label: 'Self-signed', description: 'For a private network with no public DNS. Browsers will warn about the certificate.' },
                { value: 'off', label: 'Off', description: 'Plain HTTP. Only if something in front of Astrodock already handles HTTPS.' }
              ]} />
              <span className="field-help">
                Automatic is what you want for a public server. It needs the DNS record above to be
                live first, because the certificate authority checks it.
              </span>
            </label>

            {tlsMode === 'auto' && (
              <label>
                Certificate Contact Email
                <input type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)}
                  required placeholder="you@example.com" />
                <span className="field-help">
                  Let's Encrypt uses this only to warn you if a renewal ever fails.
                </span>
              </label>
            )}

            {dns && !dns.ok && tlsMode === 'auto' && (
              <div className="callout warn">
                <b>DNS isn't pointing here yet.</b>
                <p>
                  You can save anyway — nothing breaks, and the certificate will be issued as soon
                  as the record goes live. But you won't be able to reach the dashboard at the new
                  address until it does.
                </p>
              </div>
            )}

            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? 'Applying…' : 'Save and switch over'}
            </button>
            <div className="setup-skip">
              <button type="button" className="link-btn" onClick={handleDefer} disabled={busy}>
                I'll do this later
              </button>
              <p className="field-help">
                Takes you straight to the dashboard, reachable at this server's IP over plain HTTP.
                You can't publish apps until a domain is set, and Astrodock will keep reminding you —
                but nothing here is a one-way door.
              </p>
            </div>
          </form>
        )}

        {/* ── step 2: email (optional) ─────────────────────────────────────── */}
        {!finished && step === 2 && (
          <div className="setup-body">
            <div className="callout">
              <b>Where should alerts go?</b>
              <p>
                Astrodock emails you when an app goes down, a deploy fails, or a backup does not
                run. Nothing signs in by email, so this is safe to skip — you would just be
                relying on checking the dashboard yourself. You can set it up any time later
                under Settings → Email.
              </p>
            </div>

            <EmailSetup compact testTo={email} onSaved={() => {}} />

            <button type="button" className="login-btn" onClick={() => setStep(3)}
              style={{ marginTop: 8 }}>
              Continue
            </button>
            <div className="setup-skip">
              <button type="button" className="link-btn" onClick={() => setStep(3)}>
                Skip for Now
              </button>
              <p className="field-help">On to the last step: your domain.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
