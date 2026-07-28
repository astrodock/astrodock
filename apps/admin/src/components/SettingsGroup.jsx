import { useState } from 'react';

// A settings section that owns its own draft and its own Save.
//
// The page used to batch every change on the page behind one sticky bar pinned
// to the top: log retention, disk thresholds and the alert address all committed
// by a single button, sitting far from whichever control you actually touched.
// It also held a permanent strip of vertical space to tell you "All changes
// saved", which is not news.
//
// The rule now, everywhere: THE SAVE CONTROL'S SCOPE MATCHES THE EDIT'S SCOPE.
// A set of fields you edit together gets one Save in its own header, disabled
// until something is dirty. Single-fact controls — a switch, a segmented choice
// that IS the setting — apply on change instead (see applyNow below), because a
// switch that does nothing until you find a button elsewhere reads as broken.

export default function SettingsGroup({
  title, description, keys = [], settings = [], onSave, onSaved, action, children
}) {
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const dirty = Object.keys(draft).length;
  const defs = keys.map((k) => settings.find((s) => s.key === k)).filter(Boolean);
  const valueOf = (key) => (key in draft ? draft[key] : settings.find((s) => s.key === key)?.value);

  function setField(s, value) {
    setJustSaved(false);
    setDraft((d) => ({ ...d, [s.key]: s.type === 'int' ? Number(value) : value }));
  }

  async function save() {
    setSaving(true); setError('');
    try {
      await onSave(draft);
      setDraft({});
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2600);
      onSaved?.();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <section className="set-section">
      <div className="sec-head">
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
        <div className="sec-actions">
          {justSaved && !dirty && <span className="saved-note"><span className="led ok" />Saved</span>}
          {dirty > 0 && (
            <>
              <button type="button" onClick={() => { setDraft({}); setError(''); }}>Discard</button>
              <button type="button" className="primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : `Save ${dirty} change${dirty === 1 ? '' : 's'}`}
              </button>
            </>
          )}
          {action}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {(defs.length > 0 || children) && (
        <div className="field-panel">
          {defs.map((s) => (
            <div className="field" key={s.key}>
              <div className="lab">
                <b>{s.label}</b>
                {s.description && <span className="desc">{s.description}</span>}
              </div>
              <div className="ctl">
                {s.type === 'enum' ? (
                  <div className="seg">
                    {s.values.map((v) => (
                      <button key={v} type="button" className={String(valueOf(s.key)) === String(v) ? 'sel' : ''}
                        onClick={() => setField(s, v)}>{v}</button>
                    ))}
                  </div>
                ) : (
                  <input
                    className={s.type === 'int' ? 'num' : ''}
                    type={s.type === 'int' ? 'number' : 'text'}
                    value={valueOf(s.key) ?? ''}
                    onChange={(e) => setField(s, e.target.value)}
                    style={{ marginTop: 0, width: s.type === 'int' ? 90 : 260 }}
                  />
                )}
                <span className={`src ${s.source === 'override' ? 'override' : ''}`}
                  title={s.source === 'override' ? 'Set here, overriding the installed default' : 'The value this was installed with'}>
                  {s.source}
                </span>
              </div>
            </div>
          ))}
          {children}
        </div>
      )}
    </section>
  );
}
