// One form field shape, because there were several.
//
// In the access-key dialog the name field labelled itself one way and "Starting
// point" another; help text sat *below* the starting-point picker and *above*
// the expiry one. Nothing decided which was right, so both existed.
//
// Settled: label on top, control, then help text underneath — help explains the
// control you have just been shown, so it comes after it. An error replaces the
// help text rather than joining it, so the field never argues with itself.

export default function Field({ label, hint, error, htmlFor, children, wide = false }) {
  return (
    <div className={`fld ${wide ? 'fld-wide' : ''} ${error ? 'has-error' : ''}`}>
      {label && <label className="fld-label" htmlFor={htmlFor}>{label}</label>}
      <div className="fld-control">{children}</div>
      {error
        ? <span className="field-error">{error}</span>
        : hint ? <span className="fld-hint">{hint}</span> : null}
    </div>
  );
}

// A labelled group that is not a single input — a segmented picker, a list of
// switches. Same label/hint rhythm so it lines up with the fields around it.
export function FieldGroup({ label, hint, error, children }) {
  return (
    <div className={`fld fld-group ${error ? 'has-error' : ''}`}>
      {label && <span className="fld-label">{label}</span>}
      <div className="fld-control">{children}</div>
      {error
        ? <span className="field-error">{error}</span>
        : hint ? <span className="fld-hint">{hint}</span> : null}
    </div>
  );
}
