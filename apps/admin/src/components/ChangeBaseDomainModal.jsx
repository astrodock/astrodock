import { useState } from 'react';
import { setSetupDomain } from '../lib/api';
import { ModalForm } from './Modal';
import Field, { FieldGroup } from './Field';

// Changing the main web address.
//
// The page used to say this was "done back on the server — not from this page".
// That has not been true since the first-run wizard learned to set it: the same
// endpoint takes an admin token and works at any time. So the only thing standing
// between an operator and their own domain was a paragraph saying no.
//
// It is still consequential — every app and page moves, and certificates have to
// be issued afresh — so it says exactly what will happen and asks you to type the
// new address twice rather than burying it behind a warning nobody reads.

export default function ChangeBaseDomainModal({ current, tlsMode, onClose, onDone, onReauth }) {
  const [domain, setDomain] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mode, setMode] = useState(tlsMode || 'auto');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const clean = domain.trim().toLowerCase();
  const looksLikeDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean);
  const same = clean && clean === String(current).toLowerCase();
  const mismatch = confirm.trim() && confirm.trim().toLowerCase() !== clean;
  const needsEmail = mode === 'auto' && !acmeEmail.trim();
  const ready = looksLikeDomain && !same && !mismatch && confirm.trim() && !needsEmail;

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const r = await setSetupDomain(clean, mode, acmeEmail.trim());
      onDone(`Moved to ${clean}. The dashboard is now at ${r.adminUrl || clean}.`);
    } catch (err) {
      if (err.body?.code === 'reauth_required') { onReauth(() => submit(e)); return; }
      setError(err.message); setBusy(false);
    }
  }

  return (
    <ModalForm
      title="Change Your Main Web Address"
      subtitle={`Everything currently lives under ${current}.`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="danger" disabled={busy || !ready}>
            {busy ? 'Moving…' : 'Change Address'}
          </button>
        </>
      }
    >
      <div className="rcard crit" style={{ marginBottom: 14 }}>
        <span className="led crit" />
        <span>
          <b>Every app and page moves with it.</b> This dashboard included — you will finish this
          at the new address, not this one.
        </span>
      </div>

      <ul className="plain-list">
        <li>Point <code>*.{clean || 'your-new-domain.com'}</code> at this server first. Nothing
          resolves until that DNS record is live.</li>
        <li>New HTTPS certificates are issued on first visit, so the very first load can take a
          few seconds.</li>
        <li>Links to the old address stop working. There is no redirect.</li>
        <li>Custom domains you have added are unaffected — they point at apps, not at this.</li>
      </ul>

      {error && <div className="error">{error}</div>}

      <Field label="New base domain" hint="A subdomain like apps.example.com keeps your main site free."
        error={clean && !looksLikeDomain ? 'That does not look like a domain name.'
          : same ? 'That is the address you are already on.' : null}>
        <input value={domain} onChange={(e) => setDomain(e.target.value)} spellCheck="false"
          placeholder="apps.example.com" autoComplete="off" />
      </Field>

      <Field label="Type it again to confirm"
        error={mismatch ? 'These do not match.' : null}>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} spellCheck="false"
          autoComplete="off" />
      </Field>

      <FieldGroup label="HTTPS" hint="Automatic is right for a public server, and needs the DNS record above to be live.">
        <div className="seg seg-fit">
          {[['auto', 'Automatic'], ['internal', 'Self-signed'], ['off', 'Off']].map(([v, l]) => (
            <button type="button" key={v} className={mode === v ? 'sel' : ''}
              onClick={() => setMode(v)}>{l}</button>
          ))}
        </div>
      </FieldGroup>

      {mode === 'auto' && (
        <Field label="Certificate contact email"
          hint="Let's Encrypt uses this only to warn you if a renewal fails.">
          <input type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)}
            placeholder="you@example.com" />
        </Field>
      )}
    </ModalForm>
  );
}
