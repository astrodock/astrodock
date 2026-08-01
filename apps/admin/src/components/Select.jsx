import { useState, useRef, useEffect, useCallback } from 'react';

// A dropdown that looks like the rest of the product.
//
// The native <select> renders as whatever the operating system feels like: a grey
// box on one machine, a blue-tinted one on another, an unstyleable scrolling list
// on a third. It also cannot show a description under an option, which several of
// these menus need — "Built-in (managed for you)" versus "Bring your own" is a
// decision people want a sentence about, not a parenthetical.
//
// Keyboard behaviour matches the native control, because that is the part people
// actually rely on: Up/Down move, Home/End jump, Enter and Space choose, Escape
// closes without changing anything, typing jumps to a matching label, and Tab
// leaves. The trigger is a real button, the list is a listbox, and the selected
// option is announced.

export default function Select({
  value,
  onChange,
  options,              // [{ value, label, description?, disabled? }]
  placeholder = 'Choose…',
  disabled = false,
  id,
  invalid = false
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef(null);
  const listRef = useRef(null);
  const typed = useRef({ str: '', at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex > -1 ? options[selectedIndex] : null;

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    setActive(-1);
    if (focusTrigger) root.current?.querySelector('.sel-trigger')?.focus();
  }, []);

  // Any click outside puts it away. Pointerdown rather than click so it closes
  // before whatever was clicked reacts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!root.current?.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex > -1 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  // Keep the highlighted option in view when arrowing through a long list.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelectorAll('.sel-option')[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  const step = (delta) => {
    if (!options.length) return;
    let i = active < 0 ? selectedIndex : active;
    for (let n = 0; n < options.length; n++) {
      i = (i + delta + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  function onKeyDown(e) {
    if (disabled) return;

    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;

    switch (e.key) {
      case 'Escape': e.preventDefault(); close(); break;
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'Home': e.preventDefault(); setActive(options.findIndex((o) => !o.disabled)); break;
      case 'End': e.preventDefault(); setActive(options.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); pick(active); break;
      case 'Tab': close(false); break;
      default:
        // Type-ahead, the way a native select behaves: keystrokes within a second
        // accumulate, so "po" finds Postmark rather than stopping at Postgres.
        if (e.key.length === 1) {
          const now = Date.now();
          typed.current.str = now - typed.current.at > 1000 ? e.key : typed.current.str + e.key;
          typed.current.at = now;
          const q = typed.current.str.toLowerCase();
          const hit = options.findIndex((o) => !o.disabled && String(o.label).toLowerCase().startsWith(q));
          if (hit > -1) setActive(hit);
        }
    }
  }

  return (
    <div className={`sel ${open ? 'is-open' : ''} ${invalid ? 'is-invalid' : ''}`} ref={root}>
      <button
        type="button"
        id={id}
        className="sel-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={`sel-value ${selected ? '' : 'is-placeholder'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg className="sel-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="sel-menu" role="listbox" ref={listRef} tabIndex={-1} onKeyDown={onKeyDown}>
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`sel-option ${i === active ? 'is-active' : ''} ${o.value === value ? 'is-selected' : ''} ${o.disabled ? 'is-disabled' : ''}`}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="sel-option-main">
                <span className="sel-option-label">{o.label}</span>
                {o.description && <span className="sel-option-desc">{o.description}</span>}
              </span>
              {o.value === value && (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
