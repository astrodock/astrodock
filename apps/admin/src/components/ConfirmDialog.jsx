import { useState } from 'react';
import Modal from './Modal';

// One confirmation dialog, replacing fifteen window.confirm() calls.
//
// The native one cannot be styled, says "astrodock.ai says" above whatever you
// wrote, puts OK and Cancel in the browser's order rather than yours, and looks
// identical whether you are renaming something or deleting a database. It is also
// the only piece of the product that still looked like 2004.
//
// Destructive actions take `danger`, and the ones that cannot be undone can ask
// you to type the name — the same pattern already used for restoring a backup and
// re-addressing a page, now available everywhere instead of being reinvented.

export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  typeToConfirm = null,      // a string the operator must type before confirming
  onConfirm,
  onCancel
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ready = !typeToConfirm || typed.trim() === typeToConfirm;

  async function go() {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={busy ? undefined : onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={danger ? 'danger' : 'primary'}
            onClick={go} disabled={busy || !ready}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {error && <div className="error">{error}</div>}

      <div className="confirm-body">{children}</div>

      {typeToConfirm && (
        <label className="fld" style={{ marginTop: 16 }}>
          <span className="fld-label">Type <code>{typeToConfirm}</code> to confirm</span>
          <div className="fld-control">
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
              spellCheck="false" placeholder={typeToConfirm} />
          </div>
        </label>
      )}
    </Modal>
  );
}
