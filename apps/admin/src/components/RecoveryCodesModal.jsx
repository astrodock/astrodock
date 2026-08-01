import { useState } from 'react';
import Modal from './Modal';

// Recovery codes, shown once.
//
// They used to appear inline underneath the section with a "Save these now"
// banner — on a page you can navigate away from with one click, losing the only
// copy. A modal makes the moment deliberate, and gives somewhere sensible to put
// Download and Copy, which are how people actually save these.

export default function RecoveryCodesModal({ codes, onClose }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const text = [
    'Astrodock recovery codes',
    'Each code works once. Keep them somewhere other than the device you sign in with.',
    `Generated ${new Date().toLocaleString()}`,
    '',
    ...codes
  ].join('\n');

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `astrodock-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  return (
    <Modal
      title="Your Recovery Codes"
      subtitle="This is the only time they are shown."
      onClose={acknowledged ? onClose : undefined}
      footer={
        <>
          <span className="spacer">
            <label className="ack">
              <input type="checkbox" checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)} />
              I’ve saved these somewhere safe
            </label>
          </span>
          <button type="button" className="primary" disabled={!acknowledged} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="rcard warn" style={{ marginBottom: 14 }}>
        <span className="led warn" />
        <span>
          <b>They are not shown again.</b> Each one works once, and they are the way back in if you
          lose your passkey or your phone — so keep them somewhere other than the device you sign
          in with.
        </span>
      </div>

      <div className="codes-grid">
        {codes.map((c) => <code key={c}>{c}</code>)}
      </div>

      <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 14 }}>
        <button type="button" onClick={download}>{downloaded ? 'Downloaded' : 'Download'}</button>
        <button type="button" onClick={() => {
          navigator.clipboard?.writeText(codes.join('\n'));
          setCopied(true); setTimeout(() => setCopied(false), 2000);
        }}>{copied ? 'Copied' : 'Copy All'}</button>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        Generating a new set replaces these — the old ones stop working immediately, which is also
        how you revoke them if you think they have been seen.
      </p>
    </Modal>
  );
}
