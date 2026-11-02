import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import * as api from '../lib/api';
import * as webauthn from '../lib/webauthn';
import PageHeader from '../components/PageHeader';

// First visit for an owner the hosted service created: the account has no way
// to sign in yet, so this page sets one up before anything else.
//
// A passkey is offered first and recommended. It is also what approving an
// agent asks for, and it cannot be read out to anyone. The alternative is a
// password plus an authenticator app: the password to sign in, the app's codes
// for approvals.

function PasswordAndApp({ onDone }) {
  const [step, setStep] = useState('password');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  async function savePassword(e) {
    e.preventDefault();
    if (pw.length < 8) { setError('Use at least 8 characters.'); return; }
    if (pw !== pw2) { setError('The two passwords are different.'); return; }
    setBusy(true); setError('');
    try { await api.setPassword(pw); setStep('app'); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (step !== 'app' || started.current) return;
    started.current = true;
    api.totpBegin().then(async (s) => {
      setSetup(s);
      setQr(await QRCode.toDataURL(s.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).catch(() => null));
    }).catch((err) => setError(err.message));
  }, [step]);

  async function confirm(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.totpConfirm(code.trim()); onDone(); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  if (step === 'password') {
    return (
      <form className="field-panel" onSubmit={savePassword} noValidate>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <div className="lab"><b>Password</b><span className="desc">At least 8 characters.</span></div>
          <div className="ctl"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></div>
        </div>
        <div className="field">
          <div className="lab"><b>Password Again</b></div>
          <div className="ctl"><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        </div>
        <div className="field">
          <div className="lab" />
          <div className="ctl"><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Next: Authenticator App'}</button></div>
        </div>
      </form>
    );
  }

  return (
    <form className="field-panel" onSubmit={confirm} noValidate>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <div className="lab">
          <b>Scan This</b>
          <span className="desc">With 1Password, Google Authenticator or Authy. Or type this key in: <code>{setup?.secret}</code></span>
        </div>
        <div className="ctl">{qr ? <img src={qr} alt="QR code for your authenticator app" width={180} height={180} /> : <span className="hint">Preparing…</span>}</div>
      </div>
      <div className="field">
        <div className="lab"><b>Code from the App</b><span className="desc">Six digits.</span></div>
        <div className="ctl">
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 120 }} />
          <button type="submit" className="primary" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Finish'}</button>
        </div>
      </div>
    </form>
  );
}

export default function WelcomePage({ email, onDone }) {
  const [alt, setAlt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = webauthn.supported();

  async function addPasskey() {
    setError(''); setBusy(true);
    try {
      const options = await api.passkeyOptions();
      await api.passkeyRegister({ label: 'Passkey', response: await webauthn.register(options) });
      onDone();
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? 'That was cancelled, or timed out.' : e.message);
      setBusy(false);
    }
  }

  return (
    <div className="settings-page welcome-page">
      <PageHeader title="Set Up Sign-In"
        description={`This is your Astrodock dashboard${email ? `, for ${email}` : ''}. Choose how you sign in. You use the same thing to approve what your agents do.`} />
      {error && <div className="error">{error}</div>}

      {!alt ? (
        <div className="field-panel">
          <div className="field">
            <div className="lab">
              <b>Passkey (Recommended)</b>
              <span className="desc">
                Touch ID, Face ID, Windows Hello or a security key. Nothing to remember, and it only works on this site, so
                nobody can talk you or your agent into handing it over.
              </span>
            </div>
            <div className="ctl">
              <button type="button" className="primary" onClick={addPasskey} disabled={busy || !supported}>
                {busy ? 'Waiting for Your Device…' : 'Add a Passkey'}
              </button>
            </div>
          </div>
          {!supported && <p className="hint">This browser does not support passkeys. Use a password and authenticator app instead.</p>}
          <p style={{ marginTop: 14 }}>
            <button type="button" className="link-btn" onClick={() => setAlt(true)}>Use a Password and Authenticator App Instead</button>
          </p>
        </div>
      ) : (
        <>
          <PasswordAndApp onDone={onDone} />
          <p style={{ marginTop: 14 }}>
            <button type="button" className="link-btn" onClick={() => setAlt(false)}>Use a Passkey Instead</button>
          </p>
        </>
      )}
    </div>
  );
}
