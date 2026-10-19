// Behavior for the static preview pages only. Apps get the same behavior from
// the React components (README.md); nothing here ships to an app.
//
// Hooks are data attributes, never style classes:
//   data-toggle            opens the .menu or .popover beside it
//   data-toggle-close      closes the open popover (Done)
//   data-clear             clears a multi-select
//   data-open="id"         shows a hidden overlay; data-close hides it
//   data-toast="Title|Text" shows a toast; data-undo, data-kind="danger"
//   data-tabs="#scope"     tabs that switch [data-panel] blocks in scope
//   data-view="#scope"     a toggle group that switches [data-view-panel] blocks
//   data-selectable        a list or table whose [data-row-check] boxes drive
//                          the [data-bulk] bar just before it
//   data-reveal="id"       shows and hides detail
//   data-target="id"       a nav item that scrolls to a section
//   data-filters-toggle    shows the filter sidebar on a phone
//   ⌘K / Ctrl+K           opens the command menu when the page has one

(function () {
  const ICONS = {
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
    'arrow-down-right': '<path d="m7 7 10 10"/><path d="M17 7v10H7"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    'more-vertical': '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
    refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    newspaper: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    radar: '<circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 1 0 10 10"/>',
    'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    'bar-chart': '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'file-question': '<path d="M12 17h.01"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>',
    'clipboard': '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'grip': '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    'mail': '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    'undo': '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    'message': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  };

  // ---------------------------------------------------------------- icons
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.style.display = 'none';
  sprite.innerHTML = Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('');
  document.body.prepend(sprite);
  const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // ---------------------------------------------------------------- theme
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem('kit-theme'); } catch { return null; } })();
  if (saved) root.dataset.theme = saved;
  const setTheme = (t) => { root.dataset.theme = t; try { localStorage.setItem('kit-theme', t); } catch { /* private window */ } };

  // ---------------------------------------------------------------- preview switcher
  const PAGES = [
    ['index.html', 'Overview'], ['foundations.html', 'Foundations'], ['components.html', 'Components'],
    ['page-list.html', 'Collection page'], ['page-record.html', 'Record page'], ['page-form.html', 'Create and edit'],
    ['page-settings.html', 'Settings'], ['page-dashboard.html', 'Dashboard'], ['page-activity.html', 'Background work'],
    ['page-wizard.html', 'Step by step'], ['page-sidebar.html', 'Sidebar shell and queue'], ['page-states.html', 'Sign-in, errors, loading'],
    ['mobile.html', 'On a phone'],
  ];
  if (!window.frameElement) {
    const here = location.pathname.split('/').pop() || 'index.html';
    const bar = document.createElement('div');
    bar.className = 'preview-switcher';
    bar.innerHTML = `
      <div class="menu-wrap">
        <button class="btn btn-sm" type="button" data-toggle aria-haspopup="menu" aria-expanded="false">${icon('layout-grid', 'icon icon-sm')}Kit preview: ${(PAGES.find((p) => p[0] === here) || ['', 'Page'])[1]}</button>
        <div class="menu menu-start menu-up" role="menu" hidden>
          ${PAGES.map(([href, label]) => `<a class="item" role="menuitem" href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
        </div>
      </div>
      <div class="btn-group" role="group" aria-label="Theme">
        <button class="btn btn-sm btn-icon" type="button" data-theme-set="light" aria-label="Light theme">${icon('sun', 'icon icon-sm')}</button>
        <button class="btn btn-sm btn-icon" type="button" data-theme-set="dark" aria-label="Dark theme">${icon('moon', 'icon icon-sm')}</button>
      </div>`;
    document.body.append(bar);
  }

  // ---------------------------------------------------------------- toasts
  let region = document.querySelector('.toast-region');
  if (!region) { region = document.createElement('div'); region.className = 'toast-region'; region.setAttribute('role', 'status'); document.body.append(region); }
  function toast(spec, { kind = 'success', undo = false } = {}) {
    const [title, text] = String(spec).split('|');
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="avatar avatar-sm avatar-${kind === 'danger' ? 'danger' : 'success'}">${icon(kind === 'danger' ? 'alert-triangle' : 'check')}</span>
      <div class="toast-body"><div class="toast-title"></div>${text ? '<div class="toast-text"></div>' : ''}${undo ? '<div class="actions"><button class="btn btn-sm" type="button">Undo</button></div>' : ''}</div>
      <button class="btn btn-icon btn-quiet btn-sm" type="button" aria-label="Dismiss">${icon('x')}</button>`;
    t.querySelector('.toast-title').textContent = title;
    if (text) t.querySelector('.toast-text').textContent = text;
    t.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => t.remove()));
    region.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  // ---------------------------------------------------------------- popovers
  const closeAll = (except) => document.querySelectorAll('[data-toggle][aria-expanded="true"]').forEach((b) => {
    if (b === except) return;
    b.setAttribute('aria-expanded', 'false');
    const pop = b.parentElement.querySelector(':scope > .menu, :scope > .popover');
    if (pop) pop.hidden = true;
  });

  function updateMulti(sel) {
    const picked = [...sel.querySelectorAll('.popover input[type="checkbox"]:checked')].map((c) => c.closest('[data-label]').dataset.label);
    const v = sel.querySelector('.select-trigger > .value');
    if (!v) return;
    v.classList.toggle('placeholder', !picked.length);
    v.textContent = !picked.length ? (v.dataset.placeholder || 'Any') : picked.length <= 2 ? picked.join(', ') : `${picked.length} selected`;
  }

  function syncSelection(box) {
    const rows = [...box.querySelectorAll('[data-row-check]')];
    const n = rows.filter((b) => b.checked).length;
    rows.forEach((b) => b.closest('tr, .row')?.classList.toggle('selected', b.checked));
    const all = box.querySelector('[data-all-check]');
    if (all) { all.checked = n === rows.length && n > 0; all.indeterminate = n > 0 && n < rows.length; }
    let bar = box.previousElementSibling;
    while (bar && !bar.hasAttribute('data-bulk')) bar = bar.previousElementSibling;
    if (bar) { bar.hidden = n === 0; const c = bar.querySelector('[data-selected-count]'); if (c) c.textContent = `${n} selected`; }
  }

  function openOverlay(el) {
    if (!el) return;
    el.hidden = false;
    const f = el.querySelector('[autofocus], input, textarea, .btn');
    if (f) f.focus();
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    const themeBtn = t.closest('[data-theme-set]');
    if (themeBtn) { setTheme(themeBtn.dataset.themeSet); return; }

    const toggle = t.closest('[data-toggle]');
    if (toggle) {
      const pop = toggle.parentElement.querySelector(':scope > .menu, :scope > .popover');
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      closeAll(toggle);
      toggle.setAttribute('aria-expanded', String(open));
      if (pop) { pop.hidden = !open; const f = open && pop.querySelector('input[type="search"]'); if (f) f.focus(); }
      return;
    }

    const option = t.closest('.listbox .option');
    if (option && !option.closest('.multi')) {
      const sel = option.closest('.select');
      sel.querySelectorAll('.option').forEach((o) => o.setAttribute('aria-selected', String(o === option)));
      const v = sel.querySelector('.select-trigger > .value');
      v.textContent = option.dataset.label;
      v.classList.remove('placeholder');
      closeAll();
      return;
    }
    const clear = t.closest('[data-clear]');
    if (clear) { const sel = clear.closest('.select'); sel.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = false; }); updateMulti(sel); return; }

    if (!t.closest('.menu, .popover') || t.closest('[data-toggle-close]') || t.closest('.menu .item')) closeAll();

    // A toast button inside an opener acts on its own.
    const toaster = t.closest('[data-toast]:not([data-close])');
    if (toaster) {
      toast(toaster.dataset.toast, { undo: toaster.dataset.undo === 'true', kind: toaster.dataset.kind });
      if (toaster.parentElement.closest('[data-open]')) return;
    }

    const opener = t.closest('[data-open]');
    if (opener) { openOverlay(document.getElementById(opener.dataset.open)); return; }
    const closer = t.closest('[data-close]');
    if (closer || t.classList.contains('scrim')) {
      const el = (closer || t).closest('.scrim');
      if (el) el.hidden = true;
      if (closer && closer.dataset.toast) toast(closer.dataset.toast, { undo: closer.dataset.undo === 'true', kind: closer.dataset.kind });
      return;
    }

    const tab = t.closest('[data-tabs] .tab');
    if (tab) {
      e.preventDefault();
      const groupEl = tab.closest('[data-tabs]');
      groupEl.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('current', x === tab); x.setAttribute('aria-selected', String(x === tab)); x.removeAttribute('aria-current'); });
      const scope = document.querySelector(groupEl.dataset.tabs) || document;
      scope.querySelectorAll(':scope > [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    }

    const viewBtn = t.closest('[data-view] .btn');
    if (viewBtn) {
      const groupEl = viewBtn.closest('[data-view]');
      groupEl.querySelectorAll('.btn').forEach((b) => b.setAttribute('aria-pressed', String(b === viewBtn)));
      const scope = document.querySelector(groupEl.dataset.view) || document;
      scope.querySelectorAll(':scope > [data-view-panel]').forEach((p) => { p.hidden = p.dataset.viewPanel !== viewBtn.dataset.value; });
    } else {
      const pressed = t.closest('.btn-group .btn[aria-pressed]');
      if (pressed) pressed.parentElement.querySelectorAll('.btn').forEach((b) => b.setAttribute('aria-pressed', String(b === pressed)));
    }

    const sw = t.closest('.switch');
    if (sw) sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));

    const navTarget = t.closest('[data-target]');
    if (navTarget) {
      e.preventDefault();
      navTarget.parentElement.querySelectorAll('[data-target]').forEach((b) => (b === navTarget ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
      document.getElementById(navTarget.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    const sortable = t.closest('th.sortable');
    if (sortable) {
      const next = sortable.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      sortable.closest('tr').querySelectorAll('th.sortable').forEach((h) => { h.removeAttribute('aria-sort'); const u = h.querySelector('use'); if (u) u.setAttribute('href', '#i-chevrons-up-down'); });
      sortable.setAttribute('aria-sort', next);
      const u = sortable.querySelector('use');
      if (u) u.setAttribute('href', next === 'ascending' ? '#i-chevron-up' : '#i-chevron-down');
    }

    const reveal = t.closest('[data-reveal]');
    if (reveal) {
      const el = document.getElementById(reveal.dataset.reveal);
      if (el) {
        el.hidden = !el.hidden;
        reveal.setAttribute('aria-expanded', String(!el.hidden));
        const l = reveal.querySelector('[data-reveal-label]'); if (l) l.textContent = l.textContent.replace(/^(Show|Hide)/, el.hidden ? 'Show' : 'Hide');
        const u = reveal.querySelector('use'); if (u) u.setAttribute('href', el.hidden ? '#i-chevron-right' : '#i-chevron-down');
      }
    }

    const ft = t.closest('[data-filters-toggle]');
    if (ft) {
      const side = ft.parentElement.querySelector('.filters');
      const open = !side.classList.contains('open');
      side.classList.toggle('open', open);
      ft.setAttribute('aria-expanded', String(open));
    }
  });

  document.addEventListener('change', (e) => {
    const multi = e.target.closest('.select.multi');
    if (multi) updateMulti(multi);
    const box = e.target.closest('[data-selectable]');
    if (box) {
      if (e.target.hasAttribute('data-all-check')) box.querySelectorAll('[data-row-check]').forEach((b) => { b.checked = e.target.checked; });
      syncSelection(box);
    }
  });

  document.addEventListener('input', (e) => {
    const f = e.target.closest('.popover-search input');
    if (f) {
      const q = f.value.toLowerCase();
      f.closest('.popover').querySelectorAll('.option').forEach((o) => { o.hidden = q && !o.textContent.toLowerCase().includes(q); });
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      const cmd = document.querySelector('.command-scrim');
      if (cmd) { e.preventDefault(); openOverlay(cmd); }
      return;
    }
    if (e.key !== 'Escape') return;
    closeAll();
    document.querySelectorAll('.scrim:not([hidden])').forEach((s) => { s.hidden = true; });
  });

  document.querySelectorAll('.select.multi').forEach(updateMulti);
})();
