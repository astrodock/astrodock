import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import * as api from '../lib/api';
import { ModalForm } from './Modal';
import Field from './Field';

// Setting up an authenticator app.
//
// The server has always returned an otpauth:// URI alongside the secret — that
// URI is exactly what a QR code encodes — and the old UI threw it away and
// printed the raw base32 string. So there was nothing to scan, which is how
// almost everyone sets these up. It looked broken because, practically, it was.
//
// Enrolment is also a task with a beginning and an end, not a setting: it was a
// toggle that flipped on and then demanded a code before it meant anything.

export default function TotpSetupModal({ onClose, onDone, onError }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;   // begin() rotates the secret; do it once
    started.current = true;
    api.totpBegin()
      .then(async (s) => {
        setSetup(s);
        if (s.uri) {
          // Rendered locally into a data URI — a QR service would be handed the
          // shared secret, which would rather defeat the point.
          setQr(await QRCode.toDataURL(s.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
            .catch(() => null));
        }
      })
      .catch((err) => {
        if (err.body?.code === 'reauth_required') { onClose(); onError(err); return; }
        setError(err.message);
      });
  }, [onClose, onError]);

  async function submit(e) {
    e.preventDefault();
    if (code.trim().length < 6) return;
    setBusy(true); setError('');
    try {
      await api.totpConfirm(code.trim());
      onDone('Authenticator app is on.');
    } catch (err) {
      if (err.body?.code === 'reauth_required') { onClose(); onError(err); return; }
      setError(err.message); setBusy(false);
    }
  }

  return (
    <ModalForm
      title="Add an Authenticator App"
      subtitle="Scan this once, then enter a code to prove it worked."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || code.trim().length < 6}>
            {busy ? 'Checking…' : 'Turn It On'}
          </button>
        </>
      }
    >
      {error && <div className="error">{error}</div>}

      {!setup ? (
        <p className="hint">Preparing…</p>
      ) : (
        <>
          <div className="qr-wrap">
            {qr
              ? <img src={qr} alt="QR code for your authenticator app" width={220} height={220} />
              : <p className="hint">Could not draw the QR code — use the key below instead.</p>}
          </div>

          <p className="hint" style={{ textAlign: 'center', marginBottom: 14 }}>
            Open your authenticator app — 1Password, Google Authenticator, Authy — and scan this.
          </p>

          {manual ? (
            <Field label="Or type this key in by hand"
              hint="Some apps call this a setup key or a secret.">
              <div className="linkbar">
                <code>{setup.secret}</code>
                <button type="button" onClick={() => {
                  navigator.clipboard?.writeText(setup.secret); setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
            </Field>
          ) : (
            <p style={{ textAlign: 'center', marginBottom: 16 }}>
              <button type="button" className="link-btn" onClick={() => setManual(true)}>
                Can’t scan? Enter the key manually
              </button>
            </p>
          )}

          <Field
            label="Code from the app"
            hint="Six digits. It changes every thirty seconds — nothing is switched on until one works."
          >
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
              maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </>
      )}
    </ModalForm>
  );
}
