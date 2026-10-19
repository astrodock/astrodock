// The component catalog: the one source for preview/components.html and
// REFERENCE.md (scripts/build-reference.js). Each example's markup is the
// canonical markup for that component; apps copy it, and the React
// components render it.
//
// Icons are written <svg class="icon"><use href="#i-NAME"/></svg>. In an app
// that is the Lucide icon of the same name (lucide-react: <Plus className="icon"/>).

(function () {
  const ic = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const caret = ic('chevron-down');

  const C = [];
  const group = (name) => { const g = { group: name, components: [] }; C.push(g); return g; };

  // ================================================================ Actions
  let g = group('Actions');

  g.components.push({
    id: 'buttons', title: 'Buttons',
    lede: 'Every action is a button, labeled with a verb and what it acts on. One primary button per area: the thing most people came to do.',
    use: 'Doing something: saving, adding, running, deleting.',
    notFor: 'Going somewhere (use a link). Filters (use the filter sidebar).',
    examples: [
      { title: 'Kinds', desc: 'Primary for the main action, default for others, quiet for cancel and in-row actions, danger for removing.',
        html: `<div class="actions">
  <button class="btn btn-primary" type="button">${ic('plus')}Add competitor</button>
  <button class="btn" type="button">Edit</button>
  <button class="btn btn-quiet" type="button">Cancel</button>
  <button class="btn btn-danger" type="button">${ic('trash')}Delete</button>
  <button class="btn btn-danger-solid" type="button">Delete project</button>
</div>` },
      { title: 'Sizes', desc: 'Medium everywhere. Small in rows, tables, cards and toolbars. Large only for sign-in and a first-step call to action.',
        html: `<div class="actions">
  <button class="btn btn-primary btn-lg" type="button">New project</button>
  <button class="btn btn-primary" type="button">Save changes</button>
  <button class="btn btn-sm" type="button">Retry</button>
</div>` },
      { title: 'Working and disabled', desc: 'Working keeps the label and adds a spinner. Disabled says why in a tooltip or the hint next to it.',
        html: `<div class="actions">
  <button class="btn btn-primary" type="button" disabled><span class="spinner"></span>Saving</button>
  <span class="has-tip"><button class="btn" type="button" disabled>Compare pricing</button><span class="tooltip" role="tooltip">Study at least two companies first</span></span>
</div>` },
      { title: 'Icon buttons', desc: 'Only universal actions: close, more, refresh, menu. Always with an accessible name.',
        html: `<div class="actions">
  <button class="btn btn-icon" type="button" aria-label="Refresh">${ic('refresh')}</button>
  <button class="btn btn-icon btn-quiet" type="button" aria-label="More actions">${ic('more')}</button>
  <button class="btn btn-icon btn-quiet btn-sm" type="button" aria-label="Close">${ic('x')}</button>
</div>` },
      { title: 'Toggle group', desc: 'Switching between views of the same data.',
        html: `<div class="btn-group" role="group" aria-label="Measure">
  <button class="btn btn-sm" type="button" aria-pressed="true">Cost</button>
  <button class="btn btn-sm" type="button" aria-pressed="false">Tokens</button>
  <button class="btn btn-sm" type="button" aria-pressed="false">Calls</button>
</div>` },
    ],
  });

  g.components.push({
    id: 'menus', title: 'Menus',
    lede: 'Actions needed now and then sit behind a More button: a row\'s actions beyond the first, rare page actions, and anything destructive that should not sit next to the main action.',
    use: 'Rare actions; destructive actions kept away from the main one; the account menu.',
    notFor: 'Hiding the main action. Moving between sections.',
    examples: [
      { title: 'Actions menu', desc: 'Icon, verb, an optional shortcut. Destructive items last, after a separator.',
        html: `<div class="menu-wrap">
  <button class="btn" type="button" data-toggle aria-haspopup="menu" aria-expanded="false">More${caret}</button>
  <div class="menu menu-start" role="menu" hidden>
    <button class="item" role="menuitem" type="button">${ic('pencil')}Edit details</button>
    <button class="item" role="menuitem" type="button">${ic('copy')}Duplicate<kbd class="shortcut">D</kbd></button>
    <button class="item" role="menuitem" type="button">${ic('download')}Export as CSV</button>
    <div class="menu-sep"></div>
    <button class="item danger" role="menuitem" type="button">${ic('trash')}Delete</button>
  </div>
</div>` },
      { title: 'Account menu', desc: 'Under the avatar in the shell: who is signed in, links out, sign out.',
        html: `<div class="menu-wrap">
  <button class="avatar-btn" type="button" data-toggle aria-haspopup="menu" aria-expanded="false" aria-label="Account"><span class="avatar">SL</span></button>
  <div class="menu menu-start" role="menu" hidden>
    <div class="menu-head"><span class="avatar">SL</span><span><span class="strong">Sam Lee</span><br><span class="t-xs muted">sam@example.com</span></span></div>
    <div class="menu-sep"></div>
    <a class="item" role="menuitem" href="#">${ic('external')}Open the company OS</a>
    <button class="item" role="menuitem" type="button">${ic('log-out')}Sign out</button>
  </div>
</div>` },
    ],
  });

  // ================================================================ Input
  g = group('Input');

  g.components.push({
    id: 'text-fields', title: 'Text fields',
    lede: 'A label above every field, always visible. A hint below says what is expected; an error replaces it and says how to fix it. Placeholders show an example, never instructions.',
    use: 'Short text, numbers, dates, long text.',
    notFor: 'Choosing from a known list (use a select or radios).',
    examples: [
      { title: 'Text with hint', desc: 'Optional fields are marked; required ones are not.',
        html: `<div class="field">
  <label class="field-label" for="ex-site">Website <span class="optional">Optional</span></label>
  <input class="input" id="ex-site" placeholder="storiicare.com">
  <div class="field-hint">Its whole site is read, including help and docs subdomains.</div>
</div>` },
      { title: 'Error', desc: 'Shown when the field is left and on save.',
        html: `<div class="field">
  <label class="field-label" for="ex-site2">Website</label>
  <input class="input" id="ex-site2" value="storiicare" aria-invalid="true" aria-describedby="ex-site2-e">
  <div class="field-error" id="ex-site2-e">${ic('alert-circle', 'icon icon-sm')}Enter a full address, like storiicare.com</div>
</div>` },
      { title: 'Disabled and read-only', desc: 'Read-only for values to see and copy but not change here.',
        html: `<div class="form-row">
  <div class="field"><label class="field-label" for="ex-plan">Plan</label><input class="input" id="ex-plan" value="Set by your administrator" disabled></div>
  <div class="field"><label class="field-label" for="ex-url">App address</label><input class="input mono" id="ex-url" value="intel.apps.example.com" readonly></div>
</div>` },
      { title: 'Search', desc: 'The icon inside the field. In a toolbar or the filter sidebar.',
        html: `<div class="input-wrap">${ic('search')}<input class="input" type="search" placeholder="Search companies" aria-label="Search companies"></div>` },
      { title: 'Prefix and suffix', desc: 'Units sit in the field, not in the label.',
        html: `<div class="input-affix"><span class="affix">$</span><input class="input num" value="750" aria-label="Monthly fee"><span class="affix">per center per month</span></div>` },
      { title: 'Long text', desc: 'Grows with its content to a limit, then scrolls.',
        html: `<div class="field">
  <label class="field-label" for="ex-market">The market</label>
  <textarea class="input" id="ex-market">Software for adult day centers in the US: attendance, care plans, billing, family communication.</textarea>
  <div class="field-hint">The survey searches from this.</div>
</div>` },
      { title: 'Date and time', desc: 'The browser\'s own pickers, styled as fields.',
        html: `<div class="form-row">
  <div class="field"><label class="field-label" for="ex-date">Start date</label><input class="input" id="ex-date" type="date" value="2026-11-02"></div>
  <div class="field"><label class="field-label" for="ex-time">Daily at</label><input class="input" id="ex-time" type="time" value="06:00"></div>
</div>` },
    ],
  });

  const opt = (label, hint, selected) => `    <div class="item option" role="option" aria-selected="${selected ? 'true' : 'false'}" data-label="${label}">${ic('check', 'icon check-mark')}<span><span class="option-text">${label}</span>${hint ? `<span class="option-hint">${hint}</span>` : ''}</span></div>`;
  g.components.push({
    id: 'select', title: 'Select and multi-select',
    lede: 'A button that opens a list. Never the browser\'s own select: it ignores the app\'s type and cannot show what an option means.',
    use: 'One choice from about four to ten (select). Several from a long list (multi-select). Long lists get a search box.',
    notFor: 'Two or three choices that should all be visible (use radios or choice cards).',
    examples: [
      { title: 'Select with hints', desc: 'A second line says what each option means.',
        html: `<div class="field">
  <span class="field-label" id="ex-study-l">Study</span>
  <div class="select">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-study-l"><span class="value">Light profile</span>${caret}</button>
    <div class="popover" hidden><div class="listbox" role="listbox" aria-labelledby="ex-study-l">
${opt('Light profile', 'Key pages only: home, pricing, product, about. Read once.', true)}
${opt('Full study', 'The whole site and help docs, news, website history, re-checked.')}
${opt('Not now', 'Add it without collecting anything yet.')}
    </div></div>
  </div>
</div>` },
      { title: 'Searchable, with groups', desc: 'Typing filters the list; groups keep their headings.',
        html: `<div class="field">
  <span class="field-label" id="ex-co-l">Company</span>
  <div class="select">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-co-l"><span class="value placeholder">All companies</span>${caret}</button>
    <div class="popover" hidden>
      <div class="popover-search"><div class="input-wrap">${ic('search')}<input class="input input-sm" type="search" placeholder="Search" aria-label="Search companies"></div></div>
      <div class="listbox" role="listbox" aria-labelledby="ex-co-l">
        <div class="t-label listbox-group">This project</div>
${opt('Collabrios')}
${opt('Seniorverse')}
${opt('StoriiCare')}
        <div class="t-label listbox-group">Other projects</div>
${opt('WellSky Adult Day')}
      </div>
    </div>
  </div>
</div>` },
      { title: 'Multi-select', desc: 'Checkboxes in the list; the trigger shows two names, then a count. Clear and Done at the foot.',
        html: `<div class="field">
  <span class="field-label" id="ex-types-l">Event types</span>
  <div class="select multi">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-types-l"><span class="value" data-placeholder="All types">All types</span>${caret}</button>
    <div class="popover" hidden>
      <div class="listbox" role="listbox" aria-multiselectable="true" aria-labelledby="ex-types-l">
        <label class="item option option-check" data-label="Funding"><input type="checkbox" checked>Funding<span class="count">4</span></label>
        <label class="item option option-check" data-label="Product launch"><input type="checkbox" checked>Product launch<span class="count">11</span></label>
        <label class="item option option-check" data-label="Leadership"><input type="checkbox">Leadership<span class="count">6</span></label>
        <label class="item option option-check" data-label="Partnership"><input type="checkbox">Partnership<span class="count">5</span></label>
      </div>
      <div class="popover-foot"><button class="btn btn-sm btn-quiet" type="button" data-clear>Clear</button><button class="btn btn-sm btn-primary" type="button" data-toggle-close>Done</button></div>
    </div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'choices', title: 'Checkboxes, radios, choice cards, switches',
    lede: 'One checkbox and one radio look everywhere: filters, rows, tables, forms. Switches only for settings that apply the moment they are flipped.',
    use: 'Checkboxes for independent yes/no and filters. Radios for one of two to five, all visible. Choice cards when each option needs a sentence. Switches for settings that apply at once.',
    notFor: 'A switch inside a form with a Save button (use a checkbox).',
    examples: [
      { title: 'Checkboxes and radios', desc: '',
        html: `<div class="grid-2">
  <fieldset class="filter-group"><legend class="t-label">Show</legend>
    <label class="check"><input type="checkbox" checked>Important only</label>
    <label class="check"><input type="checkbox">Where companies differ</label>
    <label class="check"><input type="checkbox" disabled>Where we lack it</label>
  </fieldset>
  <fieldset class="filter-group"><legend class="t-label">Repeat the survey</legend>
    <label class="check"><input type="radio" name="ex-rp" checked>Every month</label>
    <label class="check"><input type="radio" name="ex-rp">Every 3 months</label>
    <label class="check"><input type="radio" name="ex-rp">Only when asked</label>
  </fieldset>
</div>` },
      { title: 'Choice cards', desc: 'A decision with consequences people should read.',
        html: `<div class="grid-2">
  <label class="choice-card"><input type="radio" name="ex-lvl" checked><span><span class="strong">Light profile</span><span class="check-desc">Key pages only: home, pricing, product, about. Read once.</span></span></label>
  <label class="choice-card"><input type="radio" name="ex-lvl"><span><span class="strong">Full study</span><span class="check-desc">The whole site and help docs, news, website history, re-checked weekly.</span></span></label>
</div>` },
      { title: 'Switch', desc: 'Applies when flipped, with a toast.',
        html: `<div class="stack-sm">
  <button class="switch" type="button" role="switch" aria-checked="true" data-toast="Weekly digest on">${'<span class="switch-track"></span>'}Email me the weekly digest</button>
  <button class="switch" type="button" role="switch" aria-checked="false" data-toast="Change alerts on"><span class="switch-track"></span>Email me when a notable change is found</button>
</div>` },
    ],
  });

  g.components.push({
    id: 'file-upload', title: 'File upload',
    lede: 'A drop area that is also a button. Say what files are accepted and how large. Each file shows its progress, then a row with remove.',
    use: 'Uploading documents, imports, images.', notFor: '',
    examples: [
      { title: 'Drop area and files', desc: '',
        html: `<button class="dropzone" type="button">${ic('upload', 'icon icon-lg')}<span class="strong">Drop files here, or choose files</span><span>PDF, Word or CSV, up to 25 MB each</span></button>
<div class="mt-4">
  <div class="file-row">${ic('file')}<div class="row-main"><div class="truncate">G2 reviews export.csv</div><div class="progress mt-2" style="--value: 64%"><span></span></div></div><span class="muted num">64%</span></div>
  <div class="file-row">${ic('file')}<div class="row-main truncate">Sales call notes.pdf <span class="muted">· 1.2 MB</span></div><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Remove file">${ic('x')}</button></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'forms', title: 'Form layout',
    lede: 'One column. Two short fields may share a row when they belong together. Group under headings past six fields. Five fields or fewer go in a modal; more go on a page.',
    use: 'Every form.', notFor: '',
    examples: [
      { title: 'A form in a card', desc: 'Save in the card foot, primary last.',
        html: `<form class="card">
  <div class="card-body">
    <fieldset class="fieldset">
      <legend class="fieldset-title">The market</legend>
      <div class="fieldset-desc">What the survey and comparisons work from.</div>
      <div class="field"><label class="field-label" for="ex-pn">Project name</label><input class="input" id="ex-pn" value="Seniorverse Day"></div>
      <div class="form-row">
        <div class="field"><label class="field-label" for="ex-pp">Compare prices at</label><div class="input-affix"><input class="input num" id="ex-pp" value="50"><span class="affix">participants</span></div></div>
        <div class="field"><label class="field-label" for="ex-dd">Digest every</label><div class="input-affix"><input class="input num" id="ex-dd" value="7"><span class="affix">days</span></div></div>
      </div>
    </fieldset>
  </div>
  <div class="card-foot"><button class="btn btn-quiet" type="button">Cancel</button><button class="btn btn-primary" type="button" data-toast="Settings saved">Save</button></div>
</form>` },
      { title: 'Repeated rows', desc: 'Add another, remove each.',
        html: `<div>
  <div class="form-row-action"><div class="field"><label class="field-label" for="ex-r1">Name</label><input class="input" id="ex-r1" value="AxisCare"></div><div class="field"><label class="field-label" for="ex-r1s">Website</label><input class="input" id="ex-r1s" value="axiscare.com"></div><button class="btn btn-icon btn-quiet" type="button" aria-label="Remove AxisCare">${ic('x')}</button></div>
  <div class="form-row-action"><div class="field"><label class="sr-only" for="ex-r2">Name</label><input class="input" id="ex-r2" placeholder="Name"></div><div class="field"><label class="sr-only" for="ex-r2s">Website</label><input class="input" id="ex-r2s" placeholder="Website"></div><button class="btn btn-icon btn-quiet" type="button" aria-label="Remove this row">${ic('x')}</button></div>
  <button class="btn btn-sm mt-4" type="button">${ic('plus', 'icon icon-sm')}Add another</button>
</div>` },
    ],
  });

  // ================================================================ Showing records
  g = group('Showing records');

  g.components.push({
    id: 'avatars', title: 'Avatars',
    lede: 'People, companies and things are shown as rounded squares: initials, or an icon. Never circles. The accent avatar is the app itself or "us".',
    use: 'Leading a row, a comment, the account menu, an empty state, a confirmation.', notFor: 'Decoration.',
    examples: [
      { title: 'Sizes', desc: '24 in dense rows and timelines, 32 in lists and menus, 40 in record headers, 48 in empty states.',
        html: `<div class="cluster"><span class="avatar avatar-sm">SL</span><span class="avatar">SC</span><span class="avatar avatar-lg">SC</span><span class="avatar avatar-xl">${ic('radar')}</span></div>` },
      { title: 'Kinds', desc: 'Neutral by default. Accent for the app or us. Meaning colors only in confirmations, toasts and empty states.',
        html: `<div class="cluster"><span class="avatar">CB</span><span class="avatar avatar-accent">SV</span><span class="avatar avatar-soft">${ic('inbox')}</span><span class="avatar avatar-success">${ic('check')}</span><span class="avatar avatar-warning">${ic('alert-triangle')}</span><span class="avatar avatar-danger">${ic('trash')}</span></div>` },
    ],
  });

  g.components.push({
    id: 'cards', title: 'Cards',
    lede: 'A card holds one topic on a page: a title, actions on the right, content, and its own actions in the foot. Cards are not nested; a list or table inside a card goes flat.',
    use: 'Grouping one topic.', notFor: 'Nesting. Decorating a single line.',
    examples: [
      { title: 'Card with head and foot', desc: '',
        html: `<div class="card">
  <div class="card-head"><div><h3 class="card-title">At a glance</h3><div class="card-sub">Written 2 h ago</div></div><button class="btn btn-sm btn-quiet" type="button">Edit</button></div>
  <div class="card-body"><dl class="kv"><dt>What they sell</dt><dd>Care management software <button class="cite" type="button">F112</button></dd><dt>Team size</dt><dd class="empty-value">Not found</dd></dl></div>
  <div class="card-foot"><button class="btn btn-sm" type="button">Mark reviewed</button></div>
</div>` },
      { title: 'A card that is a link', desc: 'When the whole card stands for a record.',
        html: `<a class="card" href="#"><div class="card-body">
  <div class="cluster mb-2"><span class="avatar">SD</span><span class="strong">Seniorverse Day</span></div>
  <p class="t-small muted">Adult day center software in the US</p>
  <div class="page-meta"><span><b>6</b> companies</span><span><b>12</b> to review</span></div>
</div></a>` },
    ],
  });

  g.components.push({
    id: 'lists', title: 'Lists',
    lede: 'For records people scan by name: an avatar, the name with its labels, one line of context, aligned value cells, status, and actions at the end. Group headings split a list into parts.',
    use: 'Collections people browse by name.', notFor: 'Comparing values across many columns (use a table).',
    examples: [
      { title: 'A list with groups, cells and selection', desc: 'Selecting rows brings up the bulk bar.',
        html: `<div class="bulk-bar" data-bulk hidden><span data-selected-count>0 selected</span><div class="actions"><button class="btn btn-sm" type="button">Remove</button><button class="btn btn-sm btn-primary" type="button">Full study</button></div></div>
<div class="list" data-selectable>
  <div class="list-head"><span class="t-label">Us</span></div>
  <div class="row">
    <input type="checkbox" data-row-check aria-label="Select Seniorverse">
    <span class="avatar avatar-accent">SV</span>
    <div class="row-main"><div class="row-title"><a href="#">Seniorverse</a><span class="label label-accent">Us</span></div><div class="row-sub">seniorverse.com · Adult day software: attendance, care plans, billing</div></div>
    <div class="row-cell"><span class="t-label">Facts</span>1,015</div>
    <div class="row-cell wide"><span class="t-label">Status</span><span class="status running"><span class="spinner"></span>Collecting</span></div>
    <div class="row-end"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for Seniorverse">${ic('more')}</button></div>
  </div>
  <div class="list-head"><span class="t-label">Competitors</span><span class="count">2</span></div>
  <div class="row">
    <input type="checkbox" data-row-check aria-label="Select StoriiCare">
    <span class="avatar">SC</span>
    <div class="row-main"><div class="row-title"><a href="#">StoriiCare</a><span class="label">Full study</span></div><div class="row-sub">storiicare.com · Care management and EHR for adult day and home care</div></div>
    <div class="row-cell"><span class="t-label">Facts</span>1,842</div>
    <div class="row-cell wide"><span class="t-label">Status</span><span class="status success">${ic('check-circle')}Up to date</span></div>
    <div class="row-end"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for StoriiCare">${ic('more')}</button></div>
  </div>
  <div class="row">
    <input type="checkbox" data-row-check aria-label="Select Collabrios">
    <span class="avatar">CB</span>
    <div class="row-main"><div class="row-title"><a href="#">Collabrios</a><span class="label">Light profile</span></div><div class="row-sub">collabrios.com · Adult day and aging services software</div></div>
    <div class="row-cell"><span class="t-label">Facts</span>214</div>
    <div class="row-cell wide"><span class="t-label">Status</span><span class="status danger">${ic('alert-triangle')}1 failed</span></div>
    <div class="row-end"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for Collabrios">${ic('more')}</button></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'toolbar', title: 'Toolbar and summary',
    lede: 'Above a collection: summary counts that open filtered views, then a toolbar with search, sort, view and the result count. Filters themselves stay in the sidebar.',
    use: 'The top of every collection.', notFor: 'Filter pills.',
    examples: [
      { title: 'Summary', desc: 'Each is a link to the filtered view. The current one is outlined.',
        html: `<div class="summary">
  <a class="summary-item current" href="#"><span class="avatar avatar-sm">${ic('layout-grid')}</span><span><span class="summary-value">6</span><br><span class="summary-label">All companies</span></span></a>
  <a class="summary-item" href="#"><span class="avatar avatar-sm">${ic('eye')}</span><span><span class="summary-value">2</span><br><span class="summary-label">Changed this week</span></span></a>
  <a class="summary-item" href="#"><span class="avatar avatar-sm">${ic('inbox')}</span><span><span class="summary-value">12</span><br><span class="summary-label">Candidates to review</span></span></a>
  <a class="summary-item" href="#"><span class="avatar avatar-sm avatar-danger">${ic('alert-triangle')}</span><span><span class="summary-value">1</span><br><span class="summary-label">With failures</span></span></a>
</div>` },
      { title: 'Toolbar', desc: '',
        html: `<div class="toolbar">
  <div class="input-wrap">${ic('search')}<input class="input" type="search" placeholder="Search companies" aria-label="Search companies"><kbd>/</kbd></div>
  <div class="select select-inline">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-label="Sort by"><span class="value">Sort: Name</span>${caret}</button>
    <div class="popover" hidden><div class="listbox" role="listbox">
${opt('Sort: Name', '', true)}
${opt('Sort: Last change')}
${opt('Sort: Most facts')}
    </div></div>
  </div>
  <div class="btn-group" role="group" aria-label="View"><button class="btn btn-icon" type="button" aria-pressed="true" aria-label="List">${ic('list')}</button><button class="btn btn-icon" type="button" aria-pressed="false" aria-label="Cards">${ic('layout-grid')}</button></div>
  <span class="toolbar-count">6 companies</span>
</div>` },
    ],
  });

  g.components.push({
    id: 'tables', title: 'Tables',
    lede: 'For comparing values across rows. Headers sort when clicked. Numbers align right. A row opens its record; its own actions sit at the end. The foot gives the total and loads more.',
    use: 'Comparing values; history; logs.', notFor: 'Two columns of label and value (use key-value).',
    examples: [
      { title: 'Sortable, selectable, grouped', desc: '',
        html: `<div class="bulk-bar" data-bulk hidden><span data-selected-count>0 selected</span><div class="actions"><button class="btn btn-sm" type="button">Cancel</button><button class="btn btn-sm btn-primary" type="button" data-toast="Queued again">Retry</button></div></div>
<div class="table-box" data-selectable>
  <table class="table">
    <thead><tr>
      <th class="check-col"><input type="checkbox" data-all-check aria-label="Select all"></th>
      <th class="sortable" aria-sort="descending">When${caret}</th>
      <th class="sortable">Job${ic('chevrons-up-down')}</th>
      <th>For</th><th>Status</th><th class="num">AI calls</th><th class="num">Cost</th><th class="actions-col"><span class="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>
      <tr class="group"><td colspan="8">Today</td></tr>
      <tr class="clickable"><td class="check-col"><input type="checkbox" data-row-check aria-label="Select job 4182"></td><td class="num">2:14 PM</td><td class="primary">Read an item<span class="cell-sub">#4182</span></td><td>StoriiCare</td><td><span class="status success">${ic('check-circle')}Done</span></td><td class="num">2</td><td class="num">$0.04</td><td class="actions-col"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions">${ic('more')}</button></td></tr>
      <tr class="clickable"><td class="check-col"><input type="checkbox" data-row-check aria-label="Select job 4181"></td><td class="num">2:13 PM</td><td class="primary">Crawl pages<span class="cell-sub">#4181</span></td><td>Collabrios</td><td><span class="status running"><span class="spinner"></span>Running</span></td><td class="num"></td><td class="num"></td><td class="actions-col"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions">${ic('more')}</button></td></tr>
      <tr class="clickable"><td class="check-col"><input type="checkbox" data-row-check aria-label="Select job 4176"></td><td class="num">1:58 PM</td><td class="primary">Write the profile<span class="cell-sub">#4176</span></td><td>StoriiCare</td><td><span class="status danger">${ic('alert-triangle')}Failed</span></td><td class="num">4</td><td class="num">$0.61</td><td class="actions-col"><button class="btn btn-sm" type="button" data-toast="Queued again">Retry</button></td></tr>
    </tbody>
  </table>
  <div class="table-foot"><span>Showing 3 of 2,318 jobs</span><button class="btn btn-sm" type="button">Load more</button></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'values', title: 'Key-value, stats, labels, status',
    lede: 'Key-value lists for a record\'s fields; "Not found" or "None" rather than a blank. Stat tiles for the few numbers that matter, each linking to the list behind it. Labels describe a record in neutral gray. Status is an icon and a word in the color of its meaning.',
    use: '', notFor: 'Labels or status as buttons or filters.',
    examples: [
      { title: 'Key-value', desc: '',
        html: `<dl class="kv">
  <dt>Status</dt><dd><span class="status success">${ic('check-circle')}Done</span></dd>
  <dt>Started</dt><dd>Oct 19, 2026, 2:13 PM · waited 4 s</dd>
  <dt>For</dt><dd><a href="#">StoriiCare</a></dd>
  <dt>Error</dt><dd class="empty-value">None</dd>
</dl>` },
      { title: 'Stats', desc: '',
        html: `<div class="stat-grid">
  <a class="stat" href="#"><div class="stat-label">Spent today</div><div class="stat-value">$4.18</div><div class="stat-sub">AI $3.93 · Search $0.25</div></a>
  <a class="stat" href="#"><div class="stat-label">Candidates to review</div><div class="stat-value">12</div><div class="stat-sub up">${ic('arrow-up-right', 'icon icon-sm')}5 since the last survey</div></a>
</div>` },
      { title: 'Status', desc: 'The same five words in every app.',
        html: `<div class="cluster">
  <span class="status success">${ic('check-circle')}Done</span>
  <span class="status running"><span class="spinner"></span>Running</span>
  <span class="status neutral">${ic('clock')}Queued</span>
  <span class="status warning">${ic('alert-triangle')}Needs setup</span>
  <span class="status danger">${ic('alert-triangle')}Failed</span>
</div>` },
      { title: 'Labels and the new dot', desc: 'Labels are short nouns. The accent label only for "you" or "us". The dot marks unread or new.',
        html: `<div class="cluster"><span class="label">Full study</span><span class="label">Light profile</span><span class="label">Draft</span><span class="label label-accent">Us</span><span class="dot" aria-label="New"></span></div>` },
    ],
  });

  g.components.push({
    id: 'progress', title: 'Progress, loading',
    lede: 'Long work shows progress with words. Pages load into skeletons shaped like what is coming, never a blank page or a centered spinner. Spinners are for a working button or a running status.',
    use: '', notFor: '',
    examples: [
      { title: 'Progress', desc: 'The value is set with --value.',
        html: `<div>
  <div class="progress-head"><span class="strong">Crawling storiicare.com</span><span>132 of 412</span></div>
  <div class="progress" style="--value: 32%"><span></span></div>
  <div class="progress-note">Page 7 of 20: storiicare.com/pricing</div>
</div>
<div class="mt-4"><div class="progress-head"><span class="strong">Waiting for the first result</span></div><div class="progress indeterminate"><span></span></div></div>` },
      { title: 'Skeleton', desc: 'Widths are set with --w.',
        html: `<div class="row">
  <span class="skeleton skeleton-avatar"></span>
  <div class="row-main"><span class="skeleton" style="--w: 30%"></span><span class="skeleton" style="--w: 62%"></span></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'timeline', title: 'Timeline',
    lede: 'History newest first, grouped by year. The avatar says where an entry came from. Dates only as precise as they are known ("2021", "Mar 2021").',
    use: 'A record\'s history.', notFor: 'Logs (use a table).',
    examples: [
      { title: 'Timeline', desc: '',
        html: `<div class="timeline-year">2026</div>
<ol class="timeline">
  <li class="timeline-item"><div class="timeline-date">Oct 17</div><div class="timeline-mark"><span class="avatar avatar-sm">${ic('eye')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><div class="timeline-title">Pricing page lists a per-participant plan</div><div class="timeline-meta">Site change we saw · Notable · <a href="#">storiicare.com/pricing</a></div></div></li>
  <li class="timeline-item"><div class="timeline-date">Mar 2026</div><div class="timeline-mark"><span class="avatar avatar-sm">${ic('newspaper')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><div class="timeline-title">Launched a billing module</div><div class="timeline-text">Two press releases and a blog post describe the launch. <button class="cite" type="button">3 sources</button></div><div class="timeline-meta">Product launch · Notable</div></div></li>
  <li class="timeline-item"><div class="timeline-date">2021</div><div class="timeline-mark"><span class="avatar avatar-sm">${ic('archive')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><div class="timeline-title">Pro plan went from $149 to $199</div><div class="timeline-meta">From an archived copy · <a href="#">Archived copy</a></div></div></li>
</ol>` },
    ],
  });

  g.components.push({
    id: 'reveal', title: 'Show detail',
    lede: 'Summary first, detail on demand: a lead of two sentences, then a quiet button reveals the rest. Disclosure rows for independent topics.',
    use: 'Long sections; questions and answers.', notFor: 'Hiding something people need.',
    examples: [
      { title: 'Lead and detail', desc: '',
        html: `<div class="card">
  <div class="card-head"><h3 class="card-title">Pricing</h3><span class="t-small muted">Version 3 · 14 facts</span></div>
  <div class="card-body">
    <p>Published pricing is per participant per month, with a minimum per center. <button class="cite" type="button">F301</button></p>
    <button class="btn btn-sm btn-quiet" type="button" data-reveal="ex-pricing" aria-expanded="false">${ic('chevron-right', 'icon icon-sm')}<span data-reveal-label>Show detail</span></button>
    <div class="reveal-body prose" id="ex-pricing" hidden><p>The full section, with its tables and citations.</p></div>
  </div>
</div>` },
      { title: 'Disclosure rows', desc: '',
        html: `<details class="disclosure"><summary>${ic('chevron-right')}How are facts checked?</summary><div class="disclosure-body">Each fact keeps the exact words it rests on; a fact whose words are not on the page is dropped.</div></details>
<details class="disclosure"><summary>${ic('chevron-right')}Why is a section marked draft?</summary><div class="disclosure-body">Sections are drafts until someone marks them reviewed.</div></details>` },
    ],
  });

  g.components.push({
    id: 'text', title: 'Reading text, citations, code',
    lede: 'Long text written for reading (profiles, help, AI answers) uses prose. Citations link a claim to its source. Code blocks hold ids, JSON and logs.',
    use: '', notFor: '',
    examples: [
      { title: 'Prose with citations', desc: '',
        html: `<div class="prose"><p>StoriiCare sells care management software to adult day centers, home care agencies and care homes. <button class="cite" type="button">F112</button></p><ul><li>Pricing is published per participant per month.</li><li>Billing covers private pay and Medicaid waiver.</li></ul></div>` },
      { title: 'Short list', desc: 'Inside a card or a group.',
        html: `<ul class="bullets"><li>Publishes per-participant pricing <button class="cite" type="button">F150</button></li><li>Offers an EHR for home care <button class="cite" type="button">F151</button></li></ul>` },
      { title: 'Code block', desc: '',
        html: `<pre class="code-block">{ "companyId": 2, "force": false }</pre>` },
    ],
  });

  g.components.push({
    id: 'comments', title: 'Comments and activity',
    lede: 'A record\'s conversation and its history in one thread, oldest first, with the composer at the end.',
    use: 'Discussion on a record; who changed what.', notFor: '',
    examples: [
      { title: 'Thread', desc: '',
        html: `<div class="thread">
  <div class="comment event"><span class="avatar avatar-sm">${ic('activity')}</span><div><div class="comment-body">Submitted by a nurse · 2 h ago</div></div></div>
  <div class="comment"><span class="avatar avatar-sm">JM</span><div><div class="comment-head"><b>Jordan Moss</b><span>1 h ago</span></div><div class="comment-body">Mobility score looks low compared with April. Can we confirm before approving?</div></div></div>
  <div class="composer"><label class="sr-only" for="ex-reply">Reply</label><textarea class="input" id="ex-reply" placeholder="Reply, or @ someone"></textarea><div class="actions"><button class="btn btn-primary btn-sm" type="button">Send</button></div></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'charts', title: 'Charts',
    lede: 'Bars for amounts over time, lines for trends, a stat tile when one number says it. Series colors in fixed order, kept with their thing. A legend for two series or more, a tooltip on hover, one axis.',
    use: 'Trends that lead to a decision.', notFor: 'Decoration; status (status colors are never series colors).',
    examples: [
      { title: 'Stacked bars with a legend', desc: 'Series colors through --key.',
        html: `<div class="chart-legend"><span><i class="chart-key" style="--key: var(--series-1)"></i>Opus 5.5</span><span><i class="chart-key" style="--key: var(--series-2)"></i>Haiku 4.5</span><span><i class="chart-key" style="--key: var(--series-3)"></i>Search</span></div>
<svg class="chart" viewBox="0 0 600 160" role="img" aria-label="Estimated cost per day for 5 days, by model and search">
  <line class="chart-grid" x1="40" x2="590" y1="130" y2="130"/><line class="chart-grid" x1="40" x2="590" y1="75" y2="75"/><line class="chart-grid" x1="40" x2="590" y1="20" y2="20"/>
  <text class="chart-axis" x="34" y="133" text-anchor="end">$0</text><text class="chart-axis" x="34" y="78" text-anchor="end">$5</text><text class="chart-axis" x="34" y="23" text-anchor="end">$10</text>
  <rect x="80" y="96" width="28" height="34" fill="var(--series-1)"/><rect x="80" y="82" width="28" height="12" fill="var(--series-2)"/><path d="M80 80 V74 Q80 70 84 70 H104 Q108 70 108 74 V80 Z" fill="var(--series-3)"/>
  <rect x="190" y="70" width="28" height="60" fill="var(--series-1)"/><rect x="190" y="52" width="28" height="16" fill="var(--series-2)"/><path d="M190 50 V44 Q190 40 194 40 H214 Q218 40 218 44 V50 Z" fill="var(--series-3)"/>
  <rect x="300" y="100" width="28" height="30" fill="var(--series-1)"/><path d="M300 98 V90 Q300 86 304 86 H324 Q328 86 328 90 V98 Z" fill="var(--series-2)"/>
  <rect x="410" y="54" width="28" height="76" fill="var(--series-1)"/><rect x="410" y="34" width="28" height="18" fill="var(--series-2)"/><path d="M410 32 V28 Q410 24 414 24 H434 Q438 24 438 28 V32 Z" fill="var(--series-3)"/>
  <path d="M520 130 V108 Q520 104 524 104 H544 Q548 104 548 108 V130 Z" fill="var(--series-1)"/>
  <text class="chart-axis" x="94" y="150" text-anchor="middle">Oct 15</text><text class="chart-axis" x="204" y="150" text-anchor="middle">Oct 16</text><text class="chart-axis" x="314" y="150" text-anchor="middle">Oct 17</text><text class="chart-axis" x="424" y="150" text-anchor="middle">Oct 18</text><text class="chart-axis" x="534" y="150" text-anchor="middle">Oct 19</text>
</svg>` },
    ],
  });

  // ================================================================ Navigation
  g = group('Moving around');

  g.components.push({
    id: 'page-header', title: 'Back button and page header',
    lede: 'Every page below a section\'s first level starts with a back button naming its parent. Then the title row (avatar for a record, title, labels), a meta line, and the page\'s actions on the right: rare ones in More, the main one last and primary.',
    use: 'The top of every page.', notFor: 'Breadcrumbs (the back button replaces them).',
    examples: [
      { title: 'Record header', desc: '',
        html: `<a class="back" href="#">${ic('arrow-left')}Seniorverse Day</a>
<div class="page-head">
  <div class="page-head-main">
    <span class="avatar avatar-lg">SC</span>
    <div class="page-head-text">
      <div class="page-title-row"><h1 class="t-title">StoriiCare</h1><span class="label">Full study</span></div>
      <div class="page-meta"><a href="#">storiicare.com ${ic('external', 'icon icon-sm')}</a><span><b>1,842</b> facts</span><span class="has-tip" tabindex="0">Collected 2 h ago<span class="tooltip" role="tooltip">Oct 19, 2026, 12:14 PM</span></span><span class="status running"><span class="spinner"></span>Reading 14 items</span></div>
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-icon" type="button" aria-label="More actions">${ic('more')}</button>
    <button class="btn" type="button">${ic('refresh')}Update profile</button>
    <button class="btn btn-primary" type="button">${ic('play')}Collect again</button>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'tabs', title: 'Tabs and nav lists',
    lede: 'Tabs split a record into views and sit under the page header; the open tab is in the URL. Nav lists are the vertical version: in-page sections, settings groups, the sidebar shell. Both use the same current state.',
    use: 'Views of one record; sections of a long page.', notFor: 'Steps; filters.',
    examples: [
      { title: 'Tabs', desc: 'Counts show how much each holds.',
        html: `<div class="tabs tabs-tight" role="tablist">
  <a class="tab" aria-current="page" href="#">Profile</a>
  <a class="tab" href="#">Timeline<span class="count">38</span></a>
  <a class="tab" href="#">Facts<span class="count">1,842</span></a>
  <a class="tab" href="#">Sources<span class="count">6</span></a>
</div>` },
      { title: 'Nav list', desc: 'Group labels, icons optional, the current item filled.',
        html: `<nav class="nav-list" aria-label="On this page">
  <span class="t-label">Summary</span>
  <a class="item" aria-current="true" href="#">At a glance</a>
  <a class="item" href="#">Key points</a>
  <span class="t-label">Sections</span>
  <a class="item" href="#">Products and features</a>
  <a class="item" href="#">Pricing<span class="count">14</span></a>
</nav>` },
    ],
  });

  g.components.push({
    id: 'filters', title: 'Filters',
    lede: 'Filters live in a sidebar left of the results: checkbox groups with counts, then selects for long lists. Every filter is in the URL. Clear appears once anything is set. On a phone they fold behind a Filters button. Never a row of pills.',
    use: 'Narrowing a collection.', notFor: 'Switching views (use a toggle group).',
    examples: [
      { title: 'Filter sidebar', desc: '',
        html: `<aside class="filters" aria-label="Filters">
  <div class="filters-head"><span class="t-subheading">Filters</span><button class="btn btn-sm btn-quiet" type="button">Clear</button></div>
  <fieldset class="filter-group"><legend class="t-label">Status</legend>
    <label class="check"><input type="checkbox">Running<span class="count">7</span></label>
    <label class="check"><input type="checkbox" checked>Failed<span class="count">3</span></label>
    <label class="check"><input type="checkbox">Done<span class="count">2,308</span></label>
  </fieldset>
  <div class="filter-group"><span class="t-label" id="ex-f-co">Company</span>
    <div class="select"><button class="select-trigger input-sm" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-f-co"><span class="value">All companies</span>${caret}</button>
      <div class="popover" hidden><div class="listbox" role="listbox">
${opt('All companies', '', true)}
${opt('StoriiCare')}
${opt('Collabrios')}
      </div></div></div>
  </div>
</aside>` },
    ],
  });

  g.components.push({
    id: 'steps', title: 'Steps',
    lede: 'For decisions that must happen in order. One decision per step; Back and Next in the foot; a review before anything is committed.',
    use: 'Setting up a domain; an import with mapping.', notFor: 'Ordinary forms.',
    examples: [
      { title: 'Steps', desc: '',
        html: `<ol class="steps" aria-label="Steps"><li class="done"><span>Choose a domain</span></li><li aria-current="step"><span>Point its mail here</span></li><li><span>Test it</span></li><li><span>Review</span></li></ol>` },
    ],
  });

  // ================================================================ Feedback
  g = group('Feedback and overlays');

  g.components.push({
    id: 'modals', title: 'Modals and confirmations',
    lede: 'A modal is for a short task that blocks the page: five fields or fewer, a choice, a confirmation. Header with the title and what it does, the body, then actions on the right with the primary last. A confirmation leads with an icon tile, names what will be lost, and focuses Cancel. Escape and the scrim close both.',
    use: 'Short forms; confirmations of things that cannot be undone.', notFor: 'Long forms (use a page). Reversible removals (use an Undo toast).',
    examples: [
      { title: 'Form modal', desc: '',
        html: `<button class="btn btn-primary" type="button" data-open="ex-modal">${ic('plus')}Add competitor</button>
<div class="scrim" id="ex-modal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ex-modal-t">
    <div class="modal-head">
      <div class="overlay-heading"><div class="overlay-title" id="ex-modal-t">Add a competitor</div><div class="overlay-desc">It is added to Seniorverse Day.</div></div>
      <button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">${ic('x')}</button>
    </div>
    <div class="modal-body">
      <div class="field"><label class="field-label" for="ex-m1">Name</label><input class="input" id="ex-m1" placeholder="StoriiCare"></div>
      <div class="field"><label class="field-label" for="ex-m2">Website</label><input class="input" id="ex-m2" placeholder="storiicare.com"><div class="field-hint">A company already in another project is reused.</div></div>
      <div class="grid-2"><label class="choice-card"><input type="radio" name="ex-m-l" checked><span><span class="strong">Light profile</span><span class="check-desc">Key pages, read once.</span></span></label><label class="choice-card"><input type="radio" name="ex-m-l"><span><span class="strong">Full study</span><span class="check-desc">Everything, re-checked.</span></span></label></div>
    </div>
    <div class="modal-foot"><button class="btn btn-quiet" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-close data-toast="StoriiCare added|Collecting has started">Add competitor</button></div>
  </div>
</div>` },
      { title: 'Confirmation', desc: 'Only for what cannot be undone.',
        html: `<button class="btn btn-danger" type="button" data-open="ex-confirm">${ic('trash')}Delete project</button>
<div class="scrim" id="ex-confirm" hidden>
  <div class="modal modal-sm modal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ex-confirm-t" aria-describedby="ex-confirm-d">
    <div class="modal-head">
      <span class="avatar avatar-lg avatar-danger">${ic('trash')}</span>
      <div class="overlay-heading"><div class="overlay-title" id="ex-confirm-t">Delete Seniorverse Day?</div><div class="overlay-desc" id="ex-confirm-d">Its surveys, comparisons and digests are deleted. Its companies and what was collected about them are kept.</div></div>
    </div>
    <div class="modal-foot"><button class="btn btn-quiet" type="button" data-close autofocus>Cancel</button><button class="btn btn-danger-solid" type="button" data-close data-toast="Seniorverse Day deleted">Delete project</button></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'drawer', title: 'Drawer',
    lede: 'A record\'s detail beside the list it came from, so people can go through items without losing their place.',
    use: 'Detail of a job, a log entry, a list item.', notFor: 'Editing a large record (use its page).',
    examples: [
      { title: 'Drawer', desc: '',
        html: `<button class="btn" type="button" data-open="ex-drawer">Open job #4176</button>
<div class="scrim drawer-scrim" id="ex-drawer" hidden>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="ex-drawer-t">
    <div class="drawer-head">
      <span class="avatar avatar-lg avatar-danger">${ic('alert-triangle')}</span>
      <div class="overlay-heading"><div class="t-label overlay-eyebrow">Job #4176</div><div class="overlay-title" id="ex-drawer-t">Write the profile</div><div class="overlay-desc">StoriiCare · Failed after 3 attempts</div></div>
      <button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">${ic('x')}</button>
    </div>
    <div class="drawer-body stack">
      <div class="notice danger">${ic('alert-triangle')}<div class="notice-body"><div class="notice-title">The reply was cut off at the token limit.</div>Retrying writes the section again from the same facts.</div></div>
      <dl class="kv"><dt>Started</dt><dd>Oct 19, 2026, 1:56 PM</dd><dt>Took</dt><dd>2 min 4 s</dd><dt>AI calls</dt><dd>4 · $0.61 estimated</dd></dl>
      <div><div class="t-label mb-2">Input</div><pre class="code-block">{ "companyId": 2, "force": false }</pre></div>
    </div>
    <div class="drawer-foot"><button class="btn btn-quiet" type="button" data-close>Close</button><button class="btn btn-primary" type="button" data-close data-toast="Queued again">Retry</button></div>
  </aside>
</div>` },
    ],
  });

  g.components.push({
    id: 'command', title: 'Command menu',
    lede: 'Cmd+K or the search button in the sidebar shell: find any record or action by typing. Results grouped, arrow keys to move, Enter to open.',
    use: 'Apps with many records or sections.', notFor: 'Replacing a page\'s own search.',
    examples: [
      { title: 'Command menu', desc: '',
        html: `<button class="btn" type="button" data-open="ex-command">${ic('search')}Search<kbd>⌘K</kbd></button>
<div class="scrim command-scrim" id="ex-command" hidden>
  <div class="command" role="dialog" aria-modal="true" aria-label="Search">
    <div class="command-input">${ic('search')}<input type="text" placeholder="Search records and actions" aria-label="Search" value="stor"></div>
    <div class="command-list" role="listbox">
      <div class="t-label">Companies</div>
      <a class="item" aria-current="true" href="#"><span class="avatar avatar-sm">SC</span>StoriiCare<span class="count">Seniorverse Day</span></a>
      <div class="t-label">Actions</div>
      <button class="item" type="button">${ic('plus')}Add a competitor</button>
      <button class="item" type="button">${ic('search')}Run a survey</button>
    </div>
    <div class="command-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'toasts', title: 'Toasts',
    lede: 'A toast confirms that something worked, or offers Undo. Bottom right, a light card with an icon tile, a title and an optional line, six seconds. Errors people must act on go in the page instead.',
    use: 'Confirmations; Undo for reversible removals.', notFor: 'Errors that block work; anything to read later.',
    examples: [
      { title: 'Try them', desc: '',
        html: `<div class="actions">
  <button class="btn" type="button" data-toast="Settings saved">Confirmation</button>
  <button class="btn" type="button" data-toast="StoriiCare removed|It is still in other projects" data-undo="true">With Undo</button>
  <button class="btn" type="button" data-toast="Could not save|The connection dropped. Your changes are kept." data-kind="danger">Error</button>
</div>` },
      { title: 'Markup', desc: 'Rendered into the toast region at the bottom right.',
        html: `<div class="toast" role="status">
  <span class="avatar avatar-sm avatar-success">${ic('check')}</span>
  <div class="toast-body"><div class="toast-title">StoriiCare removed</div><div class="toast-text">It is still in other projects.</div><div class="actions"><button class="btn btn-sm" type="button">Undo</button></div></div>
  <button class="btn btn-icon btn-quiet btn-sm" type="button" aria-label="Dismiss">${ic('x')}</button>
</div>` },
    ],
  });

  g.components.push({
    id: 'notices', title: 'Notices',
    lede: 'A notice sits in the page and stays while the situation lasts: something is not set up, a run stopped, a record is read-only. Shaded, an icon, a bold first line. No colored side bar.',
    use: 'Persistent situations.', notFor: 'Confirmations (use a toast).',
    examples: [
      { title: 'Kinds', desc: '',
        html: `<div class="stack">
  <div class="notice">${ic('info')}<div class="notice-body"><div class="notice-title">This is a light profile.</div>Only the key pages were read.<div class="actions"><button class="btn btn-sm" type="button">Upgrade to full study</button></div></div></div>
  <div class="notice warning">${ic('alert-triangle')}<div class="notice-body"><div class="notice-title">Inbound email is not set up.</div>Mailing lists are not collected until INTEL_EMAIL_DOMAIN is set.</div></div>
  <div class="notice danger">${ic('alert-triangle')}<div class="notice-body"><div class="notice-title">The last survey stopped.</div>The search provider refused the key.</div></div>
  <div class="notice success">${ic('check-circle')}<div class="notice-body"><div class="notice-title">Import finished.</div>48 reviews added; 2 were already in.</div></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'empty', title: 'Empty states',
    lede: 'Nothing yet: what will be here and the first step. No matches: say so and offer to clear the filters.',
    use: 'Every list, table and section that can be empty.', notFor: '',
    examples: [
      { title: 'Nothing yet', desc: '',
        html: `<div class="list"><div class="empty"><span class="avatar avatar-xl">${ic('radar')}</span><div class="empty-title">No competitors yet</div><p class="empty-text">Add the ones you know, or run a survey to search widely first.</p><div class="actions actions-center"><button class="btn" type="button">Run a survey</button><button class="btn btn-primary" type="button">${ic('plus')}Add competitor</button></div></div></div>` },
      { title: 'No matches', desc: '',
        html: `<div class="list"><div class="empty empty-sm"><span class="avatar avatar-lg">${ic('filter')}</span><div class="empty-title">No jobs match these filters</div><p class="empty-text">Nothing failed in the last 7 days for StoriiCare.</p><button class="btn" type="button">Clear filters</button></div></div>` },
    ],
  });

  g.components.push({
    id: 'tooltips', title: 'Tooltips',
    lede: 'For an icon button\'s name, the full date behind "2 h ago", or why a button is disabled. Never for anything needed to do the work.',
    use: '', notFor: '',
    examples: [
      { title: 'Tooltips', desc: '',
        html: `<div class="cluster">
  <span class="has-tip"><button class="btn btn-icon" type="button" aria-label="Refresh">${ic('refresh')}</button><span class="tooltip" role="tooltip">Refresh</span></span>
  <span class="has-tip t-small muted" tabindex="0">2 h ago<span class="tooltip" role="tooltip">Oct 19, 2026, 2:14 PM</span></span>
</div>` },
    ],
  });

  window.KIT_CATALOG = C;
})();
