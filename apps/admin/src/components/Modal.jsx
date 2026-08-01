import { useEffect, useRef } from 'react';

// One modal shape for the whole product.
//
// Before this, every dialog invented its own: some had a close button and some
// did not, footers sat wherever the markup happened to end, and a long body
// scrolled the whole panel — including the corners, which is why the access-key
// dialog appeared square at the top and bottom right. Here the header and footer
// are pinned and only the body scrolls, so the frame keeps its shape.
//
// Also does the things a dialog is expected to do and none of them did: Escape
// closes it, focus moves inside on open, and the background does not scroll.

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false,
  busy = false          // a modal mid-operation must not be dismissed by accident
}) {
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first thing worth typing into, falling back to the panel itself
    // so the dialog — not the page behind it — owns the keyboard.
    const first = panel.current?.querySelector('input, select, textarea, button');
    (first || panel.current)?.focus?.();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  return (
    <div className="modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div className={`modal2 ${wide ? 'modal2-wide' : ''}`} ref={panel} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal2-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="modal2-close" onClick={onClose} disabled={busy}
            aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="modal2-body">{children}</div>

        {footer && <footer className="modal2-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// The form variant: same frame, but the panel IS the form so a footer submit
// button still submits and Enter still works from any field.
export function ModalForm({ title, subtitle, onClose, onSubmit, children, footer, wide, busy }) {
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector('input, select, textarea');
    first?.focus?.();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  return (
    <div className="modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <form className={`modal2 ${wide ? 'modal2-wide' : ''}`} ref={panel} noValidate
        onSubmit={onSubmit} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal2-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="modal2-close" onClick={onClose} disabled={busy}
            aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="modal2-body">{children}</div>

        {footer && <footer className="modal2-foot">{footer}</footer>}
      </form>
    </div>
  );
}
