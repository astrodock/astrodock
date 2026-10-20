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
  const opt = (label, hint, selected) => `      <div class="item option" role="option" aria-selected="${selected ? 'true' : 'false'}" data-label="${label}">${ic('check', 'icon check-mark')}<span class="option-text">${label}${hint ? `<span class="option-hint">${hint}</span>` : ''}</span></div>`;

  const C = [];
  const group = (name) => { const g = { group: name, components: [] }; C.push(g); return g; };

  // ================================================================ Actions
  let g = group('Actions');

  g.components.push({
    id: 'buttons', title: 'Buttons',
    lede: 'A verb and what it acts on. One primary button in view: the thing most people came to do. Everything else is a plain button; quiet buttons for cancel and for actions inside rows.',
    use: 'Doing something.', notFor: 'Going somewhere (a link). Filtering (the Filter button).',
    examples: [
      { title: 'Kinds', desc: 'Primary, default, quiet, danger.',
        html: `<div class="actions">
  <button class="btn btn-primary" type="button">${ic('plus')}Add competitor</button>
  <button class="btn" type="button">${ic('refresh')}Update profile</button>
  <button class="btn btn-quiet" type="button">Cancel</button>
  <button class="btn btn-danger" type="button">Delete</button>
  <button class="btn btn-danger-solid" type="button">Delete project</button>
</div>` },
      { title: 'Sizes', desc: 'Small in rows and toolbars; large only for sign-in and first-step calls to action.',
        html: `<div class="actions">
  <button class="btn btn-primary btn-lg" type="button">New project</button>
  <button class="btn btn-primary" type="button">Save changes</button>
  <button class="btn btn-sm" type="button">Retry</button>
</div>` },
      { title: 'Working and disabled', desc: 'Working keeps the label and adds a spinner. Disabled says why.',
        html: `<div class="actions">
  <button class="btn btn-primary" type="button" disabled><span class="spinner"></span>Saving</button>
  <span class="has-tip"><button class="btn" type="button" disabled>Compare pricing</button><span class="tooltip" role="tooltip">Study two companies first</span></span>
</div>` },
      { title: 'Icon buttons and shortcuts', desc: 'Icon-only for universal actions, always named for screen readers.',
        html: `<div class="actions">
  <button class="btn btn-icon" type="button" aria-label="Refresh">${ic('refresh')}</button>
  <button class="btn btn-icon btn-quiet" type="button" aria-label="More actions">${ic('more')}</button>
  <button class="btn" type="button">${ic('search')}Search<kbd>⌘K</kbd></button>
</div>` },
      { title: 'Segmented', desc: 'Switching between views of the same data.',
        html: `<div class="btn-group" role="group" aria-label="Measure">
  <button class="btn btn-sm" type="button" aria-pressed="true">Cost</button>
  <button class="btn btn-sm" type="button" aria-pressed="false">Tokens</button>
  <button class="btn btn-sm" type="button" aria-pressed="false">Calls</button>
</div>` },
    ],
  });

  g.components.push({
    id: 'menus', title: 'Menus',
    lede: 'Actions needed now and then sit behind a More button. Destructive items come last, after a line.',
    use: 'Rare actions; the account menu.', notFor: 'Hiding the main action.',
    examples: [
      { title: 'Actions menu', desc: '',
        html: `<div class="menu-wrap">
  <button class="btn" type="button" data-toggle aria-haspopup="menu" aria-expanded="false">More${caret}</button>
  <div class="menu menu-start" role="menu" hidden>
    <button class="item" role="menuitem" type="button">${ic('pencil')}Rename</button>
    <button class="item" role="menuitem" type="button">${ic('copy')}Duplicate<kbd class="shortcut">D</kbd></button>
    <button class="item" role="menuitem" type="button">${ic('download')}Export as CSV</button>
    <div class="menu-sep"></div>
    <button class="item danger" role="menuitem" type="button">${ic('trash')}Delete</button>
  </div>
</div>` },
    ],
  });

  // ================================================================ Input
  g = group('Input');

  g.components.push({
    id: 'text-fields', title: 'Text fields',
    lede: 'A label above every field. A hint below says what is expected; an error replaces it and says how to fix it. Placeholders show an example, never instructions.',
    use: 'Short text, numbers, dates, long text.', notFor: 'Choosing from a known list.',
    examples: [
      { title: 'With a hint', desc: 'Optional fields are marked; required ones are not.',
        html: `<div class="field">
  <label class="field-label" for="ex-site">Website<span class="optional">Optional</span></label>
  <input class="input" id="ex-site" placeholder="storiicare.com">
  <div class="field-hint">Its whole site is read, including help and docs subdomains.</div>
</div>` },
      { title: 'With an error', desc: '',
        html: `<div class="field">
  <label class="field-label" for="ex-site2">Website</label>
  <input class="input" id="ex-site2" value="storiicare" aria-invalid="true" aria-describedby="ex-site2-e">
  <div class="field-error" id="ex-site2-e">${ic('alert-circle', 'icon icon-sm')}Enter a full address, like storiicare.com</div>
</div>` },
      { title: 'Search, prefix and suffix', desc: '',
        html: `<div class="stack">
  <div class="input-wrap">${ic('search')}<input class="input" type="search" placeholder="Search companies" aria-label="Search companies"><kbd>/</kbd></div>
  <div class="input-affix"><span class="affix">$</span><input class="input num" value="750" aria-label="Monthly fee"><span class="affix">per center / month</span></div>
</div>` },
      { title: 'Long text, disabled, read-only', desc: '',
        html: `<div class="stack">
  <div class="field"><label class="field-label" for="ex-market">The market</label><textarea class="input" id="ex-market">Software for adult day centers in the US: attendance, care plans, billing, family communication.</textarea></div>
  <div class="form-row">
    <div class="field"><label class="field-label" for="ex-plan">Plan</label><input class="input" id="ex-plan" value="Set by your administrator" disabled></div>
    <div class="field"><label class="field-label" for="ex-url">App address</label><input class="input mono" id="ex-url" value="intel.apps.example.com" readonly></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'select', title: 'Select and multi-select',
    lede: 'A button that opens a list. Never the browser\'s own select. Options can say what they mean; long lists get a search box.',
    use: 'One choice from four or more; several from a long list.', notFor: 'Two or three choices that should be visible (radios).',
    examples: [
      { title: 'Select', desc: '',
        html: `<div class="field">
  <span class="field-label" id="ex-study-l">Study</span>
  <div class="select">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-study-l"><span class="value">Light profile</span>${ic('chevrons-up-down')}</button>
    <div class="popover" hidden><div class="listbox" role="listbox" aria-labelledby="ex-study-l">
${opt('Light profile', 'Key pages only, read once', true)}
${opt('Full study', 'Whole site, news and history, re-checked')}
${opt('Not now', 'Add it without collecting')}
    </div></div>
  </div>
</div>` },
      { title: 'Multi-select with search', desc: 'Shows two names, then a count.',
        html: `<div class="field">
  <span class="field-label" id="ex-types-l">Event types</span>
  <div class="select multi">
    <button class="select-trigger" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ex-types-l"><span class="value" data-placeholder="All types">All types</span>${ic('chevrons-up-down')}</button>
    <div class="popover" hidden>
      <div class="popover-search"><div class="input-wrap">${ic('search')}<input class="input input-sm" type="search" placeholder="Search" aria-label="Search types"></div></div>
      <div class="listbox" role="listbox" aria-multiselectable="true" aria-labelledby="ex-types-l">
        <label class="item option option-check" data-label="Funding"><input type="checkbox" checked>Funding<span class="count">4</span></label>
        <label class="item option option-check" data-label="Product launch"><input type="checkbox" checked>Product launch<span class="count">11</span></label>
        <label class="item option option-check" data-label="Leadership"><input type="checkbox">Leadership<span class="count">6</span></label>
        <label class="item option option-check" data-label="Partnership"><input type="checkbox">Partnership<span class="count">5</span></label>
      </div>
      <div class="popover-foot"><button class="btn btn-sm btn-quiet" type="button" data-clear>Clear</button><button class="btn btn-sm" type="button" data-toggle-close>Done</button></div>
    </div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'choices', title: 'Checkboxes, radios, choice cards, switches',
    lede: 'One checkbox and one radio, everywhere. Choice cards when each option needs a sentence. Switches only for settings that apply the moment they are flipped.',
    use: '', notFor: 'A switch inside a form with Save (use a checkbox).',
    examples: [
      { title: 'Checkboxes and radios', desc: '',
        html: `<div class="grid-2">
  <fieldset class="check-list"><legend class="t-label mb-2">Show</legend>
    <label class="check"><input type="checkbox" checked>Important only</label>
    <label class="check"><input type="checkbox">Where companies differ</label>
    <label class="check"><input type="checkbox" disabled>Where we lack it</label>
  </fieldset>
  <fieldset class="check-list"><legend class="t-label mb-2">Repeat the survey</legend>
    <label class="check"><input type="radio" name="ex-rp" checked>Every month</label>
    <label class="check"><input type="radio" name="ex-rp">Every 3 months</label>
    <label class="check"><input type="radio" name="ex-rp">Only when asked</label>
  </fieldset>
</div>` },
      { title: 'Choice cards', desc: '',
        html: `<div class="grid-2">
  <label class="choice-card"><input type="radio" name="ex-lvl" checked><span><span class="medium">Light profile</span><span class="check-desc">Key pages only: home, pricing, product, about. Read once.</span></span></label>
  <label class="choice-card"><input type="radio" name="ex-lvl"><span><span class="medium">Full study</span><span class="check-desc">Whole site and help docs, news, history. Re-checked weekly.</span></span></label>
</div>` },
      { title: 'Switch', desc: '',
        html: `<div class="stack-sm">
  <button class="switch" type="button" role="switch" aria-checked="true" data-toast="Weekly digest on"><span class="switch-track"></span>Email me the weekly digest</button>
  <button class="switch" type="button" role="switch" aria-checked="false" data-toast="Change alerts on"><span class="switch-track"></span>Email me notable changes</button>
</div>` },
    ],
  });

  g.components.push({
    id: 'forms', title: 'Forms',
    lede: 'Each group of fields gets a short title and a sentence on the left, the fields on the right, hairlines between groups. On a phone the intro sits above. Long forms end with the save bar; short ones go in a modal.',
    use: 'Every form with more than five fields.', notFor: '',
    examples: [
      { title: 'Form', desc: '',
        html: `<form class="form">
  <div class="fieldset">
    <div class="fieldset-intro"><div class="fieldset-title">The market</div><div class="fieldset-desc">What the survey and comparisons work from.</div></div>
    <div class="fieldset-body">
      <div class="field"><label class="field-label" for="ex-pn">Project name</label><input class="input" id="ex-pn" value="Seniorverse Day"></div>
      <div class="form-row">
        <div class="field"><label class="field-label" for="ex-pp">Compare prices at</label><div class="input-affix"><input class="input num" id="ex-pp" value="50"><span class="affix">participants</span></div></div>
        <div class="field"><label class="field-label" for="ex-dd">Digest every</label><div class="input-affix"><input class="input num" id="ex-dd" value="7"><span class="affix">days</span></div></div>
      </div>
    </div>
  </div>
  <div class="fieldset">
    <div class="fieldset-intro"><div class="fieldset-title">Surveys</div><div class="fieldset-desc">Repeat surveys list only companies not found before.</div></div>
    <div class="fieldset-body"><div class="check-list"><label class="check"><input type="radio" name="ex-fr" checked>Every month</label><label class="check"><input type="radio" name="ex-fr">Only when asked</label></div></div>
  </div>
</form>` },
      { title: 'Save bar', desc: 'Appears when something changed; stays at the bottom of the window.',
        html: `<div class="save-bar"><span>Unsaved changes</span><div class="actions"><button class="btn btn-quiet" type="button">Discard</button><button class="btn btn-primary" type="button" data-toast="Saved">Save changes</button></div></div>` },
    ],
  });

  g.components.push({
    id: 'file-upload', title: 'File upload',
    lede: 'A drop area that is also a button; it says what is accepted. Each file shows progress, then a row with remove.',
    use: '', notFor: '',
    examples: [
      { title: 'Drop area', desc: '',
        html: `<div class="stack">
  <button class="dropzone" type="button">${ic('upload', 'icon icon-lg')}<span class="medium">Drop files, or choose files</span><span>PDF, Word or CSV, up to 25 MB</span></button>
  <div class="file-list">
    <div class="file-row">${ic('file')}<div class="progress-item w-full"><div class="progress-head"><span>G2 reviews.csv</span><span>64%</span></div><div class="progress" style="--value: 64%"><span></span></div></div></div>
    <div class="file-row">${ic('file')}<span class="truncate">Sales call notes.pdf</span><span class="spacer"></span><span class="muted">1.2 MB</span><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Remove file">${ic('x')}</button></div>
  </div>
</div>` },
    ],
  });

  // ================================================================ Showing records
  g = group('Showing records');

  g.components.push({
    id: 'avatars', title: 'Avatars',
    lede: 'People, companies and things are rounded squares: initials or an icon. Neutral by default; the accent for the app itself or "us".',
    use: 'Leading a row, a comment, the switcher, an empty state.', notFor: 'Circles. Decoration.',
    examples: [
      { title: 'Sizes and kinds', desc: '20 and 24 inline, 32 in lists, 40 in record headers, 48 in empty states.',
        html: `<div class="cluster">
  <span class="avatar avatar-xs">SL</span><span class="avatar avatar-sm">SL</span><span class="avatar">SC</span><span class="avatar avatar-lg">SC</span><span class="avatar avatar-xl">${ic('radar')}</span>
  <span class="avatar avatar-accent">SV</span><span class="avatar avatar-soft">${ic('inbox')}</span><span class="avatar avatar-danger">${ic('trash')}</span>
</div>` },
    ],
  });

  g.components.push({
    id: 'lists', title: 'Lists',
    lede: 'The main way to show records. Columns are set once on the list; the header names them once. Rows are separated by hairlines, open on click, and show their checkbox and actions on hover. Group labels split a list into parts.',
    use: 'Collections people scan and open.', notFor: 'Repeating labels in every row. Boxes around each row.',
    examples: [
      { title: 'List with columns, groups and selection', desc: 'Select rows to bring up the bulk bar.',
        html: `<div class="list" data-selectable style="--cols: minmax(0, 1fr) 72px 104px 120px 32px">
  <div class="list-header"><span>Company</span><span class="num">Facts</span><span>Last change</span><span>Status</span><span></span></div>
  <div class="row-group">Us</div>
  <div class="row">
    <div class="row-lead"><span class="row-pick"><input type="checkbox" data-row-check aria-label="Select Seniorverse"><span class="avatar avatar-accent">SV</span></span><div class="row-main"><a class="row-title row-link" href="#">Seniorverse</a><span class="row-sub">seniorverse.com</span></div></div>
    <span class="row-cell num">1,015</span><span class="row-cell">Oct 18</span><span class="row-cell"><span class="status running"><span class="spinner"></span>Collecting</span></span>
    <div class="row-end row-hover"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for Seniorverse">${ic('more')}</button></div>
  </div>
  <div class="row-group">Competitors<span class="count">2</span></div>
  <div class="row">
    <div class="row-lead"><span class="row-pick"><input type="checkbox" data-row-check aria-label="Select StoriiCare"><span class="avatar">SC</span></span><div class="row-main"><span class="row-title"><a class="row-link" href="#">StoriiCare</a><span class="label">Full study</span></span><span class="row-sub">storiicare.com</span></div></div>
    <span class="row-cell num">1,842</span><span class="row-cell">Oct 17</span><span class="row-cell"><span class="status success"><span class="status-dot"></span>Up to date</span></span>
    <div class="row-end row-hover"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for StoriiCare">${ic('more')}</button></div>
  </div>
  <div class="row">
    <div class="row-lead"><span class="row-pick"><input type="checkbox" data-row-check aria-label="Select Collabrios"><span class="avatar">CB</span></span><div class="row-main"><span class="row-title"><a class="row-link" href="#">Collabrios</a><span class="label">Light profile</span></span><span class="row-sub">collabrios.com</span></div></div>
    <span class="row-cell num">214</span><span class="row-cell">Oct 12</span><span class="row-cell"><span class="status danger"><span class="status-dot"></span>1 failed</span></span>
    <div class="row-end row-hover"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions for Collabrios">${ic('more')}</button></div>
  </div>
  <div class="bulk-bar" data-bulk hidden><span data-selected-count>0 selected</span><button class="btn btn-sm" type="button">${ic('refresh')}Collect again</button><button class="btn btn-sm" type="button">${ic('x')}Remove</button></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'view-bar', title: 'View bar and filters',
    lede: 'Above a collection: saved views on the left, then Filter, search, sort and layout on the right. Filters open from the Filter button; a badge shows how many are set. Pages with heavy filtering may use the filter sidebar instead.',
    use: 'The top of every collection.', notFor: 'Rows of filter pills.',
    examples: [
      { title: 'View bar', desc: 'Open Filter to see the panel.',
        html: `<div class="view-bar">
  <div class="views" role="tablist" aria-label="Views">
    <button class="view" type="button" aria-current="true">All<span class="count">6</span></button>
    <button class="view" type="button">Changed this week<span class="count">2</span></button>
    <button class="view" type="button">Needs attention<span class="count">1</span></button>
  </div>
  <span class="spacer"></span>
  <div class="menu-wrap">
    <button class="btn btn-sm" type="button" data-toggle aria-haspopup="dialog" aria-expanded="false">${ic('filter')}Filter<span class="filter-badge">1</span></button>
    <div class="popover popover-wide menu-start" role="dialog" aria-label="Filters" hidden>
      <div class="popover-section"><span class="t-label">Study</span>
        <label class="item option option-check"><input type="checkbox" checked>Full study<span class="count">3</span></label>
        <label class="item option option-check"><input type="checkbox">Light profile<span class="count">2</span></label>
        <label class="item option option-check"><input type="checkbox">Not studied<span class="count">1</span></label>
      </div>
      <div class="popover-section"><span class="t-label">Status</span>
        <label class="item option option-check"><input type="checkbox">Collecting<span class="count">1</span></label>
        <label class="item option option-check"><input type="checkbox">Has failures<span class="count">1</span></label>
      </div>
      <div class="popover-foot"><button class="btn btn-sm btn-quiet" type="button">Clear all</button><button class="btn btn-sm" type="button" data-toggle-close>Done</button></div>
    </div>
  </div>
  <div class="input-wrap">${ic('search')}<input class="input input-sm" type="search" placeholder="Search" aria-label="Search companies"></div>
  <div class="btn-group btn-group-sm" role="group" aria-label="Layout"><button class="btn btn-icon" type="button" aria-pressed="true" aria-label="List">${ic('list')}</button><button class="btn btn-icon" type="button" aria-pressed="false" aria-label="Cards">${ic('layout-grid')}</button></div>
</div>` },
      { title: 'Filter sidebar', desc: 'Only for pages people filter constantly (logs, history).',
        html: `<aside class="filters" aria-label="Filters">
  <div class="filters-head"><span class="t-subheading">Filters</span><button class="btn btn-sm btn-quiet" type="button">Clear</button></div>
  <fieldset class="filter-group"><legend class="t-label">Status</legend>
    <label class="check"><input type="checkbox">Running<span class="count">7</span></label>
    <label class="check"><input type="checkbox" checked>Failed<span class="count">3</span></label>
    <label class="check"><input type="checkbox">Done<span class="count">2,308</span></label>
  </fieldset>
</aside>` },
    ],
  });

  g.components.push({
    id: 'tables', title: 'Tables',
    lede: 'For comparing many values across rows. Headers sort when clicked; numbers align right; the foot gives the total and loads more.',
    use: 'Logs, history, numbers.', notFor: 'Records people browse by name (a list).',
    examples: [
      { title: 'Table', desc: '',
        html: `<div class="table-box flush">
  <table class="table">
    <thead><tr><th class="sortable" aria-sort="descending">When${caret}</th><th class="sortable">Job${ic('chevrons-up-down')}</th><th>For</th><th>Status</th><th class="num">AI calls</th><th class="num">Cost</th><th class="actions-col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>
      <tr class="group"><td colspan="7">Today</td></tr>
      <tr class="clickable"><td class="num">2:14 PM</td><td class="primary">Read an item<span class="cell-sub">#4182</span></td><td>StoriiCare</td><td><span class="status success"><span class="status-dot"></span>Done</span></td><td class="num">2</td><td class="num">$0.04</td><td class="actions-col"><button class="btn btn-sm btn-quiet btn-icon" type="button" aria-label="Actions">${ic('more')}</button></td></tr>
      <tr class="clickable"><td class="num">1:58 PM</td><td class="primary">Write the profile<span class="cell-sub">#4176</span></td><td>StoriiCare</td><td><span class="status danger"><span class="status-dot"></span>Failed</span></td><td class="num">4</td><td class="num">$0.61</td><td class="actions-col"><button class="btn btn-sm" type="button" data-toast="Queued again">Retry</button></td></tr>
    </tbody>
  </table>
  <div class="table-foot"><span>2 of 2,318 jobs</span><button class="btn btn-sm" type="button">Load more</button></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'sections', title: 'Sections and properties',
    lede: 'Inside a page, content is sections, not cards: a title, a line of meta or an action, then the content, with hairlines between. A record\'s fields sit in a properties list in the side column.',
    use: 'Record pages, settings, dashboards.', notFor: 'Cards around every group.',
    examples: [
      { title: 'Sections', desc: '',
        html: `<div class="sections">
  <section class="section">
    <div class="section-head"><h2 class="section-title">Summary</h2><span class="section-meta">Written 2 h ago</span></div>
    <p class="section-lead">StoriiCare sells care management and EHR software to adult day centers, home care agencies and care homes.<button class="cite" type="button">1</button></p>
  </section>
  <section class="section">
    <div class="section-head"><h2 class="section-title">Pricing</h2><div class="actions"><span class="section-meta">14 facts</span><button class="btn btn-sm" type="button">${ic('check')}Mark reviewed</button></div></div>
    <p class="section-lead">Published pricing is per participant per month, with a minimum per center.<button class="cite" type="button">1</button></p>
  </section>
</div>` },
      { title: 'Properties', desc: '',
        html: `<dl class="properties">
  <dt>Website</dt><dd><a class="link" href="#">storiicare.com</a></dd>
  <dt>Study</dt><dd><span class="label">Full study</span></dd>
  <dt>Status</dt><dd><span class="status success"><span class="status-dot"></span>Up to date</span></dd>
  <dt>Founded</dt><dd>[From the profile]</dd>
  <dt>Team size</dt><dd class="faint">Not found</dd>
</dl>` },
      { title: 'Properties, stacked', desc: 'For values that run to a sentence: the label above the value.',
        html: `<dl class="properties stacked">
  <dt>What they sell</dt><dd>Care management and EHR software for adult day centers and home care.<button class="cite" type="button">1</button></dd>
  <dt>Who it is for</dt><dd>Adult day centers, home care agencies and care homes in the UK and US.<button class="cite" type="button">2</button></dd>
  <dt>Team size</dt><dd class="faint">Not found</dd>
</dl>` },
    ],
  });

  g.components.push({
    id: 'screenshots', title: 'Screenshots',
    lede: 'Pictures of screens and pages: a shaded frame, cropped from the top, with a caption and where it came from. Selecting one opens the viewer: the picture large, its details beside it.',
    use: 'Website and product screenshots, uploaded pictures.', notFor: 'Decoration; icons and logos.',
    examples: [
      { title: 'Grid', desc: 'Captions name what it shows, then where and when.',
        html: `<div class="shot-grid">
  <button class="shot" type="button"><span class="shot-frame"></span><span class="shot-text"><span class="shot-cap">Attendance</span><span class="shot-sub">help.storiicare.com · Oct 12</span></span></button>
  <button class="shot" type="button"><span class="shot-frame"></span><span class="shot-text"><span class="shot-cap">Billing and claims</span><span class="shot-sub">App Store · Sep 30</span></span></button>
  <button class="shot" type="button"><span class="shot-frame"></span><span class="shot-text"><span class="shot-cap">Care plans and notes</span><span class="shot-sub">Added by Paul · Oct 2</span></span></button>
</div>` },
      { title: 'A page on desktop and phone', desc: 'The frame takes the picture\'s own shape through --ratio.',
        html: `<div class="shot-pair">
  <button class="shot" type="button"><span class="shot-frame"></span><span class="shot-text"><span class="shot-cap">Home page</span><span class="shot-sub">Desktop · Oct 12</span></span></button>
  <button class="shot" type="button"><span class="shot-frame" style="--ratio: 390 / 844"></span><span class="shot-text"><span class="shot-cap">Phone</span></span></button>
</div>` },
      { title: 'Their words', desc: 'A headline copied word for word, set apart by size.',
        html: `<div class="stack-sm"><p class="quote-lg">“Adult day software that families love”</p><p class="muted">Attendance, billing and care plans in one place.</p></div>` },
    ],
  });

  g.components.push({
    id: 'values', title: 'Stats, labels, status',
    lede: 'Stats for the few numbers that matter, each linking to the list behind it. Labels describe a record in gray. Status is a dot and a word; color only for success, attention and failure.',
    use: '', notFor: 'Labels or status as buttons or filters.',
    examples: [
      { title: 'Stats', desc: '',
        html: `<div class="stat-grid">
  <a class="stat" href="#"><div class="stat-label">Spent this month</div><div class="stat-value">$61.40</div><div class="stat-sub">AI $58.20 · Search $3.20</div></a>
  <a class="stat" href="#"><div class="stat-label">Candidates to review</div><div class="stat-value">12</div><div class="stat-sub up">${ic('arrow-up-right', 'icon icon-sm')}5 since the last survey</div></a>
</div>` },
      { title: 'Status and labels', desc: '',
        html: `<div class="stack">
  <div class="cluster"><span class="status success"><span class="status-dot"></span>Done</span><span class="status running"><span class="spinner"></span>Running</span><span class="status"><span class="status-dot"></span>Queued</span><span class="status warning"><span class="status-dot"></span>Needs setup</span><span class="status danger"><span class="status-dot"></span>Failed</span></div>
  <div class="cluster"><span class="label">Full study</span><span class="label label-outline">Draft</span><span class="label label-accent">Us</span><span class="dot" aria-label="New"></span></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'progress', title: 'Progress and loading',
    lede: 'Long work shows progress in words. Pages load into skeletons shaped like what is coming.',
    use: '', notFor: 'A blank page or a centered spinner.',
    examples: [
      { title: 'Progress', desc: '',
        html: `<div class="progress-item">
  <div class="progress-head"><span class="medium">Crawling storiicare.com</span><span>132 of 412</span></div>
  <div class="progress" style="--value: 32%"><span></span></div>
  <div class="progress-note">Page 7 of 20: storiicare.com/pricing</div>
</div>` },
      { title: 'Skeleton', desc: '',
        html: `<div class="row"><div class="row-lead"><span class="skeleton skeleton-avatar"></span><div class="row-main w-full"><span class="skeleton" style="--w: 30%"></span><span class="skeleton" style="--w: 55%"></span></div></div></div>` },
    ],
  });

  g.components.push({
    id: 'timeline', title: 'Timeline',
    lede: 'History newest first. The icon says where an entry came from; dates only as precise as they are known.',
    use: 'A record\'s history.', notFor: 'Logs (a table).',
    examples: [
      { title: 'Timeline', desc: '',
        html: `<ol class="timeline">
  <li class="timeline-item"><div class="timeline-mark"><span class="avatar avatar-sm">${ic('eye')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><span class="timeline-title">Pricing page lists a per-participant plan</span><span class="timeline-meta">Site change we saw</span></div><span class="timeline-date">Oct 17</span></li>
  <li class="timeline-item"><div class="timeline-mark"><span class="avatar avatar-sm">${ic('newspaper')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><span class="timeline-title">Launched a billing module</span><span class="timeline-meta">Product launch · <button class="link" type="button">3 sources</button></span></div><span class="timeline-date">Mar 2026</span></li>
  <li class="timeline-item"><div class="timeline-mark"><span class="avatar avatar-sm">${ic('archive')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><span class="timeline-title">Pro plan went from $149 to $199</span><span class="timeline-meta">From an archived copy</span></div><span class="timeline-date">2021</span></li>
</ol>` },
    ],
  });

  g.components.push({
    id: 'text', title: 'Reading text, detail, citations',
    lede: 'Long text uses prose. A lead first; Show detail reveals the rest. Citations are small numbered marks that open their source.',
    use: '', notFor: '',
    examples: [
      { title: 'Lead and detail', desc: '',
        html: `<div class="stack-sm">
  <p class="section-lead">Published pricing is per participant per month, with a minimum per center.<button class="cite" type="button">1</button></p>
  <div><button class="btn btn-sm btn-quiet align-start" type="button" data-reveal="ex-pricing" aria-expanded="false">${ic('chevron-right', 'icon icon-sm')}<span data-reveal-label>Show detail</span></button></div>
  <div class="reveal-body prose" id="ex-pricing" hidden><p>The full section, with its tables and citations.</p><ul><li>Plan A: per participant per month.</li><li>Setup fee waived on annual terms.</li></ul></div>
</div>` },
      { title: 'Disclosure', desc: '',
        html: `<div><details class="disclosure"><summary>${ic('chevron-right')}How are facts checked?</summary><div class="disclosure-body">Each fact keeps the exact words it rests on.</div></details><details class="disclosure"><summary>${ic('chevron-right')}Why is a section a draft?</summary><div class="disclosure-body">Until someone marks it reviewed.</div></details></div>` },
      { title: 'Code', desc: '', html: `<pre class="code-block">{ "companyId": 2, "force": false }</pre>` },
    ],
  });

  g.components.push({
    id: 'comments', title: 'Comments',
    lede: 'A record\'s discussion and history in one thread; the composer last.',
    use: '', notFor: '',
    examples: [
      { title: 'Thread', desc: '',
        html: `<div class="thread">
  <div class="comment event"><span class="avatar avatar-sm">${ic('activity')}</span><div class="comment-body">Submitted by Jordan Moss · 2 h ago</div></div>
  <div class="comment"><span class="avatar avatar-sm">SL</span><div><div class="comment-head"><b>Sam Lee</b><span>1 h ago</span></div><div class="comment-body">Mobility is lower than April. Can we confirm before approving?</div></div></div>
  <div class="composer"><label class="sr-only" for="ex-reply">Reply</label><textarea id="ex-reply" placeholder="Reply…"></textarea><div class="composer-foot"><span>Mention with @</span><button class="btn btn-sm btn-primary" type="button" data-toast="Reply sent">Send</button></div></div>
</div>` },
    ],
  });

  // ---- Chart markup. These build the same markup an app's chart component
  // renders; the examples below show the result. Exposed as KIT_CHARTS so the
  // preview pages draw their charts with the same code.
  const num = (n, money) => (money ? '$' + n.toFixed(2) : n.toLocaleString('en-US'));
  const tick = (n, money) => (money ? '$' + n : n.toLocaleString('en-US'));
  const at = (v, max) => `${+((v / max) * 100).toFixed(2)}%`;
  const key = (i, line) => `<i class="chart-key${line ? ' line' : ''}" style="--c: var(--series-${i + 1})"></i>`;
  const legend = (series, line) => `<div class="chart-legend">${series.map((n, i) => `<span>${key(i, line)}${n}</span>`).join('')}</div>`;
  const tip = (c, series, money) => {
    const rows = series.map((n, i) => `<div class="chart-tip-row">${key(i)}${n}<b>${num(c.v[i], money)}</b></div>`).join('');
    const total = series.length > 1 ? `<div class="chart-tip-row total">Total<b>${num(c.v.reduce((a, b) => a + b, 0), money)}</b></div>` : '';
    return `<div class="chart-tip" aria-hidden="true"><div class="chart-tip-title">${c.full || c.x}</div>${rows}${total}</div>`;
  };
  const colLabel = (c, series, money) => `${c.full || c.x}: ${series.map((n, i) => `${n} ${num(c.v[i], money)}`).join(', ')}`;
  const frame = ({ label, max, ticks, money, short, cols, lines }, inner) => `<div class="chart-plot${short ? ' short' : ''}" role="group" aria-label="${label}">
  <div class="chart-y" aria-hidden="true">${ticks.map((t) => `<span style="--at: ${at(t, max)}">${tick(t, money)}</span>`).join('')}</div>
  <div class="chart-area${lines ? ' lines' : ''}">
    ${ticks.filter((t) => t > 0).map((t) => `<span class="chart-gridline" style="--at: ${at(t, max)}"></span>`).join('')}
${inner}
  </div>
  <div class="chart-x" aria-hidden="true">${cols.map((c) => `<span>${c.tick === false ? '' : c.x}</span>`).join('')}</div>
</div>`;
  const barChart = (o) => frame(o, o.cols.map((c) => {
    const total = c.v.reduce((a, b) => a + b, 0);
    const segs = c.v.map((v, i) => (v ? `<span style="--n: ${v}; --c: var(--series-${i + 1})"></span>` : '')).join('');
    return `    <div class="chart-col" tabindex="0" aria-label="${colLabel(c, o.series, o.money)}"><div class="chart-bar" style="--v: ${at(total, o.max)}">${segs}</div>${tip(c, o.series, o.money)}</div>`;
  }).join('\n'));
  const linePath = (vals, max) => vals.map((v, j) => `${j ? 'L' : 'M'}${+(((j + 0.5) / vals.length) * 100).toFixed(2)} ${+(100 - (v / max) * 100).toFixed(2)}`).join(' ');
  const lineChart = (o) => {
    const paths = o.series.map((n, i) => {
      const d = linePath(o.cols.map((c) => c.v[i]), o.max);
      const fill = o.series.length === 1 ? `<path class="chart-fill" d="${d} V100 H${+((0.5 / o.cols.length) * 100).toFixed(2)} Z" style="--c: var(--series-${i + 1})"/>` : '';
      return `${fill}<path class="chart-line" d="${d}" style="--c: var(--series-${i + 1})"/>`;
    }).join('');
    const cols = o.cols.map((c) => `    <div class="chart-col" tabindex="0" aria-label="${colLabel(c, o.series, o.money)}">${c.v.map((v, i) => `<span class="chart-point" style="--v: ${at(v, o.max)}; --c: var(--series-${i + 1})"></span>`).join('')}${tip(c, o.series, o.money)}</div>`).join('\n');
    return frame({ ...o, lines: true }, `    <svg class="chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>\n${cols}`);
  };
  const sparkline = (vals, color = 1) => {
    const max = Math.max(...vals) * 1.1;
    const d = vals.map((v, j) => `${j ? 'L' : 'M'}${+((j / (vals.length - 1)) * 100).toFixed(2)} ${+(32 - (v / max) * 32).toFixed(2)}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true" style="--c: var(--series-${color})"><path class="chart-fill" d="${d} V32 H0 Z"/><path d="${d}"/></svg>`;
  };
  const barList = (rows, { head, money } = {}) => {
    const max = Math.max(...rows.map((r) => r[1]));
    const total = rows.reduce((a, r) => a + r[1], 0);
    return `<div class="bar-list">
  ${head ? `<div class="bar-list-head"><span>${head[0]}</span><span>${head[1]}</span></div>` : ''}
${rows.map(([n, v]) => `  <div class="bar-list-row" style="--v: ${at(v, max)}"><span>${n}</span><span class="num">${num(v, money)}</span><span class="num">${Math.round((v / total) * 100)}%</span></div>`).join('\n')}
</div>`;
  };
  const chartTable = (o) => `<div class="table-box flush"><table class="table table-compact"><thead><tr><th>${o.xName || 'Day'}</th>${o.series.map((n) => `<th class="num">${n}</th>`).join('')}</tr></thead><tbody>${o.cols.map((c) => `<tr><td>${c.full || c.x}</td>${c.v.map((v) => `<td class="num">${num(v, o.money)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const chartBlock = (id, o, { title, value, change, down } = {}) => `<div class="chart-block">
  <div class="chart-head">
    <div class="chart-heading"><span class="chart-title">${title}</span><span class="chart-value">${value}${change ? `<span class="chart-change">${ic(down ? 'trending-down' : 'trending-up')}${change}</span>` : ''}</span></div>
    <div class="actions">
      <div class="btn-group btn-group-sm" role="group" aria-label="Period">${(o.periods || ['7 days', '30 days', '90 days']).map((p, i) => `<button class="btn" type="button" aria-pressed="${i === 0}">${p}</button>`).join('')}</div>
      <div class="btn-group btn-group-sm" role="group" aria-label="Show as" data-view="#${id}"><button class="btn btn-icon" type="button" aria-pressed="true" data-value="chart" aria-label="Chart">${ic('bar-chart')}</button><button class="btn btn-icon" type="button" aria-pressed="false" data-value="table" aria-label="Table">${ic('table')}</button></div>
    </div>
  </div>
  ${o.series.length > 1 ? legend(o.series, o.lines) : ''}
  <div id="${id}">
    <div data-view-panel="chart">
${(o.lines ? lineChart : barChart)(o)}
    </div>
    <div data-view-panel="table" hidden>${chartTable(o)}</div>
  </div>
</div>`;
  window.KIT_CHARTS = { barChart, lineChart, sparkline, barList, chartBlock, legend };

  const week = [['Mon', 'Mon, Oct 13', [212, 148]], ['Tue', 'Tue, Oct 14', [318, 260]], ['Wed', 'Wed, Oct 15', [146, 170]], ['Thu', 'Thu, Oct 16', [262, 208]], ['Fri', 'Fri, Oct 17', [96, 120]], ['Sat', 'Sat, Oct 18', [301, 244]], ['Sun', 'Sun, Oct 19', [152, 98]]]
    .map(([x, full, v]) => ({ x, full, v }));
  const cost = [[4.1, 1.2, 0.3], [6.8, 1.6, 0.4], [3.2, 0.9, 0.2], [9.4, 2.1, 0.6], [5.6, 1.4, 0.3], [11.2, 2.6, 0.7], [7.9, 1.8, 0.4]]
    .map((v, i) => ({ x: week[i].x, full: week[i].full, v }));

  g.components.push({
    id: 'charts', title: 'Charts',
    lede: 'A chart answers one question. Its head says the answer (the total and the change); the plot shows the shape. Every chart has a tooltip on each column, a table view, and a legend when it has two series or more.',
    use: 'Bars for amounts per day or week; lines for trends and rates; a sparkline inside a stat; a bar list for a ranked breakdown.',
    notFor: 'Pies, donuts, 3D, two y-axes, or status (status colors are never series colors).',
    examples: [
      { title: 'Bars over time', desc: 'Stacked when the parts add up to a total. Hover or tab to a column.',
        html: chartBlock('chart-work', { label: 'Items collected and read per day, last 7 days', series: ['Collected', 'Read'], cols: week, max: 600, ticks: [0, 200, 400, 600] },
          { title: 'Work finished', value: '3,035', change: '12% on last week' }) },
      { title: 'Lines for trends', desc: 'Up to five series in fixed order. A single series gets a soft fill.',
        html: chartBlock('chart-cost', { label: 'AI and search cost per day by model, last 7 days', series: ['Opus 5.5', 'Haiku 4.5', 'Search'], cols: cost, max: 12, ticks: [0, 4, 8, 12], money: true, lines: true },
          { title: 'AI and search cost', value: '$63.90', change: '8% on last week', down: true }) },
      { title: 'Stats with a trend', desc: 'A sparkline shows direction only; the number is the point.',
        html: `<div class="stat-grid">
  <a class="stat" href="#"><div class="stat-label">AI calls today</div><div class="stat-value">1,284</div><div class="stat-sub">${ic('trending-up', 'icon icon-sm')}18% on yesterday</div>${sparkline([820, 940, 760, 1010, 980, 1090, 1284])}</a>
  <a class="stat" href="#"><div class="stat-label">Spent this month</div><div class="stat-value">$61.40</div><div class="stat-sub">AI $58.20 · Search $3.20</div>${sparkline([12, 19, 24, 31, 40, 52, 61], 2)}</a>
  <a class="stat" href="#"><div class="stat-label">Jobs failed</div><div class="stat-value">3</div><div class="stat-sub">Last 7 days</div>${sparkline([1, 0, 2, 0, 0, 1, 3], 3)}</a>
</div>` },
      { title: 'Breakdown', desc: 'Ranked largest first, with the amount and its share.',
        html: barList([['Writing profiles', 31.2], ['Reading items', 14.6], ['Dating facts', 6.1], ['Surveys', 4.3], ['Search', 3.2]], { head: ['Purpose', 'Cost this month'], money: true }) },
    ],
  });

  // ================================================================ Moving around
  g = group('Moving around');

  g.components.push({
    id: 'page-header', title: 'Page header',
    lede: 'Back (below a section\'s first level), then the title row with its actions, then tabs when the record has views. The main action is last and primary; rare ones go in More.',
    use: 'The top of every page.', notFor: 'Breadcrumbs.',
    examples: [
      { title: 'Record header with tabs', desc: '',
        html: `<header class="page-header">
  <a class="back" href="#">${ic('chevron-left')}Seniorverse Day</a>
  <div class="page-head">
    <div class="page-head-main">
      <span class="avatar avatar-lg">SC</span>
      <div class="page-head-text">
        <div class="page-title-row"><h1 class="t-title">StoriiCare</h1><span class="label">Full study</span></div>
        <div class="page-meta"><a class="link" href="#">storiicare.com</a><span>Collected 2 h ago</span><span class="status running"><span class="spinner"></span>Reading 14 items</span></div>
      </div>
    </div>
    <div class="actions"><button class="btn btn-icon" type="button" aria-label="More actions">${ic('more')}</button><button class="btn" type="button">Update profile</button><button class="btn btn-primary" type="button">Collect again</button></div>
  </div>
  <nav class="tabs" aria-label="Views"><a class="tab" aria-current="page" href="#">Profile</a><a class="tab" href="#">Timeline<span class="count">38</span></a><a class="tab" href="#">Facts<span class="count">1,842</span></a><a class="tab" href="#">Sources</a></nav>
</header>` },
    ],
  });

  g.components.push({
    id: 'nav-list', title: 'Navigation list',
    lede: 'The vertical list in the sidebar, in settings, and for a long page\'s sections. Current is a neutral fill; labels group it; counts on the right.',
    use: '', notFor: '',
    examples: [
      { title: 'Navigation list', desc: '',
        html: `<nav class="nav-list" aria-label="Sections">
  <a class="item" href="#">${ic('layout-grid')}Home</a>
  <a class="item" aria-current="page" href="#">${ic('inbox')}To review<span class="count">8</span></a>
  <div class="nav-label">Projects</div>
  <a class="item" href="#"><span class="avatar avatar-xs">SD</span>Seniorverse Day</a>
  <a class="item" href="#"><span class="avatar avatar-xs">SH</span>Seniorverse Home Care</a>
</nav>` },
    ],
  });

  g.components.push({
    id: 'account-menu', title: 'Account menu',
    lede: 'The person, at the foot of the sidebar. It says who is signed in, links to their account on the sign-in host, sets the theme, and signs out. Signing out of the app sends people to the platform sign-out so the next app asks again.',
    use: 'Every app, in the sidebar foot.', notFor: 'App settings (Settings, above it).',
    examples: [
      { title: 'Open', desc: 'The theme choice is a set of radio items; the current one has a check.',
        html: `<div class="menu-wrap">
  <button class="item" type="button" data-toggle aria-haspopup="menu" aria-expanded="false"><span class="avatar avatar-xs">SL</span>Sam Lee${ic('chevrons-up-down', 'icon icon-sm end')}</button>
  <div class="menu menu-start" role="menu" hidden>
    <div class="menu-head"><span class="avatar avatar-sm">SL</span><span class="menu-head-text"><span class="medium">Sam Lee</span><span>sam@example.com</span></span></div>
    <a class="item" role="menuitem" href="#">${ic('user')}Your account${ic('external', 'icon icon-sm end')}</a>
    <div class="menu-sep"></div>
    <div class="menu-head"><span class="t-label">Theme</span></div>
    <div role="group" aria-label="Theme">
      <button class="item option option-check" type="button" role="menuitemradio" aria-checked="false" data-theme-set="light">${ic('check', 'icon check-mark')}<span class="option-text">Light</span></button>
      <button class="item option option-check" type="button" role="menuitemradio" aria-checked="false" data-theme-set="dark">${ic('check', 'icon check-mark')}<span class="option-text">Dark</span></button>
      <button class="item option option-check" type="button" role="menuitemradio" aria-checked="false" data-theme-set="auto">${ic('check', 'icon check-mark')}<span class="option-text">Match this device</span></button>
    </div>
    <div class="menu-sep"></div>
    <button class="item" type="button" role="menuitem">${ic('help-circle')}Help</button>
    <button class="item" type="button" role="menuitem">${ic('log-out')}Sign out</button>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'steps', title: 'Steps',
    lede: 'For decisions that must happen in order, with a review before anything is committed.',
    use: '', notFor: 'Ordinary forms.',
    examples: [
      { title: 'Steps', desc: '', html: `<ol class="steps" aria-label="Steps"><li class="done"><span>Choose a domain</span></li><li aria-current="step"><span>Point its mail here</span></li><li><span>Test it</span></li><li><span>Review</span></li></ol>` },
    ],
  });

  // ================================================================ Feedback
  g = group('Feedback and overlays');

  g.components.push({
    id: 'modals', title: 'Modals and confirmations',
    lede: 'A modal is for a short task that blocks the page. Title and what it does, the fields, then actions on the right with the primary last. A confirmation is smaller: an icon, the question, what will be lost, two buttons. Escape and the backdrop close both.',
    use: 'Up to five fields; things that cannot be undone.', notFor: 'Long forms (a page). Reversible removals (Undo in a toast).',
    examples: [
      { title: 'Modal', desc: '',
        html: `<button class="btn btn-primary" type="button" data-open="ex-modal">${ic('plus')}Add competitor</button>
<div class="scrim" id="ex-modal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ex-modal-t">
    <div class="modal-head">
      <div class="overlay-heading"><div class="overlay-title" id="ex-modal-t">Add a competitor</div><div class="overlay-desc">It is added to Seniorverse Day and studied right away.</div></div>
      <button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">${ic('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-row"><div class="field"><label class="field-label" for="ex-m1">Name</label><input class="input" id="ex-m1" placeholder="StoriiCare"></div><div class="field"><label class="field-label" for="ex-m2">Website</label><input class="input" id="ex-m2" placeholder="storiicare.com"></div></div>
      <div class="grid-2"><label class="choice-card"><input type="radio" name="ex-m-l" checked><span><span class="medium">Light profile</span><span class="check-desc">Key pages, read once</span></span></label><label class="choice-card"><input type="radio" name="ex-m-l"><span><span class="medium">Full study</span><span class="check-desc">Everything, re-checked</span></span></label></div>
    </div>
    <div class="modal-foot"><button class="btn btn-quiet" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-close data-toast="StoriiCare added|Collecting has started">Add competitor</button></div>
  </div>
</div>` },
      { title: 'Confirmation', desc: '',
        html: `<button class="btn btn-danger" type="button" data-open="ex-confirm">Delete project</button>
<div class="scrim" id="ex-confirm" hidden>
  <div class="modal modal-sm modal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ex-confirm-t" aria-describedby="ex-confirm-d">
    <div class="modal-head">
      <span class="avatar avatar-danger">${ic('trash')}</span>
      <div class="overlay-heading"><div class="overlay-title" id="ex-confirm-t">Delete Seniorverse Day?</div><div class="overlay-desc" id="ex-confirm-d">Its surveys, comparisons and digests are deleted. The companies and what was collected about them are kept.</div></div>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-close autofocus>Cancel</button><button class="btn btn-danger-solid" type="button" data-close data-toast="Seniorverse Day deleted">Delete project</button></div>
  </div>
</div>` },
      { title: 'Session ended', desc: 'Signing in again opens in a new window, so nothing typed here is lost.',
        html: `<button class="btn" type="button" data-open="ex-session">Show session ended</button>
<div class="scrim" id="ex-session" hidden>
  <div class="modal modal-sm modal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ex-session-t" aria-describedby="ex-session-d">
    <div class="modal-head">
      <span class="avatar">${ic('key')}</span>
      <div class="overlay-heading"><div class="overlay-title" id="ex-session-t">Sign in again to keep working</div><div class="overlay-desc" id="ex-session-d">Your session ended after 12 hours. What you typed stays on this page; sign in and then save.</div></div>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" type="button" data-close autofocus>Sign in again</button></div>
  </div>
</div>` },
      { title: 'Leaving with unsaved changes', desc: 'Only when something was changed. Keep editing has focus.',
        html: `<button class="btn" type="button" data-open="ex-leave">Show leave without saving</button>
<div class="scrim" id="ex-leave" hidden>
  <div class="modal modal-sm modal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ex-leave-t" aria-describedby="ex-leave-d">
    <div class="modal-head">
      <span class="avatar avatar-warning">${ic('alert-triangle')}</span>
      <div class="overlay-heading"><div class="overlay-title" id="ex-leave-t">Leave without saving?</div><div class="overlay-desc" id="ex-leave-d">Your changes to the project description and 2 settings are lost.</div></div>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-close autofocus>Keep editing</button><button class="btn btn-danger-solid" type="button" data-close>Discard changes</button></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'drawer', title: 'Drawer',
    lede: 'A record\'s detail beside the list it came from, floating over the page.',
    use: 'Jobs, log entries, quick looks.', notFor: 'Editing a large record (its page).',
    examples: [
      { title: 'Drawer', desc: '',
        html: `<button class="btn" type="button" data-open="ex-drawer">Open job #4176</button>
<div class="scrim drawer-scrim" id="ex-drawer" hidden>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="ex-drawer-t">
    <div class="drawer-head">
      <div class="overlay-heading"><span class="t-label">Job #4176</span><div class="overlay-title" id="ex-drawer-t">Write the profile</div><span class="status danger"><span class="status-dot"></span>Failed after 3 attempts</span></div>
      <button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">${ic('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="notice danger">${ic('alert-triangle')}<div class="notice-body"><span class="notice-title">The reply was cut off at the token limit.</span><span>Retrying writes the section again from the same facts.</span></div></div>
      <dl class="properties"><dt>For</dt><dd><span class="avatar avatar-xs">SC</span>StoriiCare</dd><dt>Started</dt><dd>Oct 19, 1:56 PM</dd><dt>Took</dt><dd>2 min 4 s</dd><dt>AI calls</dt><dd>4 · $0.61 estimated</dd></dl>
      <div class="stack-sm"><span class="t-label">Input</span><pre class="code-block">{ "companyId": 2, "force": false }</pre></div>
    </div>
    <div class="drawer-foot"><button class="btn" type="button" data-close>Close</button><button class="btn btn-primary" type="button" data-close data-toast="Queued again">Retry</button></div>
  </aside>
</div>` },
    ],
  });

  g.components.push({
    id: 'command', title: 'Command menu',
    lede: 'Cmd+K anywhere: find a record or run an action by typing.',
    use: '', notFor: 'Replacing a page\'s own search.',
    examples: [
      { title: 'Command menu', desc: '',
        html: `<button class="btn" type="button" data-open="ex-command">${ic('search')}Search<kbd>⌘K</kbd></button>
<div class="scrim command-scrim" id="ex-command" hidden>
  <div class="command" role="dialog" aria-modal="true" aria-label="Search">
    <div class="command-input">${ic('search')}<input type="text" placeholder="Search or run a command" aria-label="Search" value="stor"></div>
    <div class="command-list" role="listbox">
      <div class="nav-label">Companies</div>
      <a class="item" aria-current="true" href="#"><span class="avatar avatar-xs">SC</span>StoriiCare<span class="count">Seniorverse Day</span></a>
      <div class="nav-label">Actions</div>
      <button class="item" type="button">${ic('plus')}Add a competitor</button>
      <button class="item" type="button">${ic('search')}Run a survey</button>
    </div>
    <div class="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd>Move</span><span><kbd>↵</kbd>Open</span><span><kbd>esc</kbd>Close</span></div>
  </div>
</div>` },
    ],
  });

  g.components.push({
    id: 'toasts', title: 'Toasts',
    lede: 'A short line at the bottom right confirming what happened, with Undo when it can be undone. Six seconds. Errors people must act on stay in the page.',
    use: 'Confirmations; Undo.', notFor: 'Errors that block work.',
    examples: [
      { title: 'Try them', desc: '',
        html: `<div class="actions">
  <button class="btn" type="button" data-toast="Settings saved">Saved</button>
  <button class="btn" type="button" data-toast="StoriiCare removed|Still in 2 other projects" data-undo="true">With Undo</button>
  <button class="btn" type="button" data-toast="Could not save|The connection dropped; your changes are kept" data-kind="danger">Error</button>
</div>` },
      { title: 'Markup', desc: '',
        html: `<div class="toast" role="status">${ic('check-circle')}<div class="toast-body"><div class="toast-title">StoriiCare removed</div><div class="toast-text">Still in 2 other projects</div></div><button class="btn btn-sm" type="button">Undo</button><button class="btn btn-icon btn-quiet btn-sm" type="button" aria-label="Dismiss">${ic('x')}</button></div>` },
    ],
  });

  g.components.push({
    id: 'notices', title: 'Notices',
    lede: 'A notice stays in the page while a situation lasts. Neutral for information, tinted for attention and failure. No colored side bar.',
    use: '', notFor: 'Confirmations (a toast).',
    examples: [
      { title: 'Kinds', desc: '',
        html: `<div class="stack">
  <div class="notice">${ic('info')}<div class="notice-body"><span class="notice-title">This is a light profile.</span><span>Only the key pages were read.</span><div class="actions"><button class="btn btn-sm" type="button">Upgrade to full study</button></div></div></div>
  <div class="notice warning">${ic('alert-triangle')}<div class="notice-body"><span class="notice-title">Inbound email is not set up.</span><span>Mailing lists are not collected.</span></div></div>
  <div class="notice danger">${ic('alert-triangle')}<div class="notice-body"><span class="notice-title">The last survey stopped.</span><span>The search provider refused the key.</span></div></div>
</div>` },
      { title: 'States that last', desc: 'At the top of the page they affect, above the header when they affect the whole app.',
        html: `<div class="stack">
  <div class="notice warning">${ic('wifi-off')}<div class="notice-body"><span class="notice-title">You are offline.</span><span>Changes are kept on this page and saved when the connection is back.</span></div></div>
  <div class="notice">${ic('lock')}<div class="notice-body"><span class="notice-title">You can view this project.</span><span>Only its owners can change it. Sam Lee can give you edit access.</span></div></div>
  <div class="notice warning">${ic('git-compare')}<div class="notice-body"><span class="notice-title">Ann Ruiz changed this project 2 min ago.</span><span>Saving now replaces their changes to the description.</span><div class="actions"><button class="btn btn-sm" type="button">Load their version</button><button class="btn btn-sm btn-quiet" type="button">Save mine anyway</button></div></div></div>
  <div class="notice danger">${ic('alert-triangle')}<div class="notice-body"><span class="notice-title">2 of 14 could not be archived.</span><span>CareWatch and Turning Point Systems are still collecting. The other 12 were archived.</span><div class="actions"><button class="btn btn-sm" type="button">${ic('refresh')}Try those 2 again</button></div></div></div>
  <div class="notice warning">${ic('clock')}<div class="notice-body"><span class="notice-title">Too many searches at once.</span><span>The search provider asked us to slow down. Surveys continue on their own in about a minute.</span></div></div>
</div>` },
    ],
  });

  g.components.push({
    id: 'empty', title: 'Empty states',
    lede: 'Nothing yet: what will be here and the first step. No matches: say so, and offer to clear filters.',
    use: '', notFor: '',
    examples: [
      { title: 'Nothing yet', desc: '',
        html: `<div class="empty"><span class="avatar avatar-xl">${ic('radar')}</span><div class="empty-title">No competitors yet</div><p class="empty-text">Add the ones you know, or run a survey to find more.</p><div class="actions actions-center"><button class="btn" type="button">Run a survey</button><button class="btn btn-primary" type="button">${ic('plus')}Add competitor</button></div></div>` },
      { title: 'No matches', desc: '',
        html: `<div class="empty empty-sm"><div class="empty-title">No jobs match</div><p class="empty-text">Nothing failed in the last 7 days.</p><button class="btn btn-sm" type="button">Clear filters</button></div>` },
    ],
  });

  window.KIT_CATALOG = C;
})();
