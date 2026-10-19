# Writes the static preview pages in preview/ (everything except catalog.js,
# preview.js and preview.css, which are edited by hand). Run from anywhere:
#   python3 scripts/build-preview.py   (Python 3.12 or later)
# then: node scripts/check.js && node scripts/build-reference.js
import json, os, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'preview')
FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">'

def kit_js(expr):
    # Evaluates expr after loading preview/catalog.js (KIT_CATALOG, KIT_CHARTS); returns its JSON.
    code = ("const vm = require('vm'), fs = require('fs'); const window = {}; "
            "vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), { window }); "
            "process.stdout.write(JSON.stringify((" + expr + ")(window)));")
    out = subprocess.run(['node', '-e', code, os.path.join(OUT, 'catalog.js')], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

def chart(fn, *args):
    return kit_js(f'(w) => w.KIT_CHARTS.{fn}(...{json.dumps(list(args))})')

def ic(name, cls='icon'):
    return f'<svg class="{cls}" aria-hidden="true"><use href="#i-{name}"/></svg>'

def page(filename, title, body, scripts=''):
    html = f'''<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
{FONTS}
<link rel="stylesheet" href="../kit.css">
<link rel="stylesheet" href="preview.css">
</head>
<body>
{body.strip()}
{scripts}<script src="preview.js"></script>
</body>
</html>
'''
    with open(os.path.join(OUT, filename), 'w') as f:
        f.write(html)

# ----------------------------------------------------------------------- shared pieces
def item(icon, label, attrs='', danger=False, tag='button', role='menuitem'):
    cls = 'item danger' if danger else 'item'
    lead = ic(icon) if icon else ''
    if tag == 'a':
        return f'<a class="{cls}" role="{role}" {attrs}>{lead}{label}</a>'
    return f'<button class="{cls}" role="{role}" type="button" {attrs}>{lead}{label}</button>'

def more_menu(items, label='More actions', quiet=False, sm=False):
    cls = 'btn btn-icon' + (' btn-quiet' if quiet else '') + (' btn-sm' if sm else '')
    return f'<div class="menu-wrap"><button class="{cls}" type="button" data-toggle aria-haspopup="menu" aria-expanded="false" aria-label="{label}">{ic("more")}</button><div class="menu" role="menu" hidden>{items}</div></div>'

def select(label_id, value, options, small=False, inline=False):
    opts = '\n'.join(f'<div class="item option" role="option" aria-selected="{"true" if o == value else "false"}" data-label="{o}">{ic("check", "icon check-mark")}<span class="option-text">{o}</span></div>' for o in options)
    return f'''<div class="select{' select-inline' if inline else ''}"><button class="select-trigger{' input-sm' if small else ''}" type="button" data-toggle aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{label_id}"><span class="value">{value}</span>{ic('chevrons-up-down')}</button>
  <div class="popover" hidden><div class="listbox" role="listbox" aria-labelledby="{label_id}">
{opts}
  </div></div></div>'''

def status(kind, text):
    if kind == 'running':
        return f'<span class="status running"><span class="spinner"></span>{text}</span>'
    return f'<span class="status {kind}"><span class="status-dot"></span>{text}</span>'

def header(title, back=None, avatar='', labels='', meta='', desc='', actions='', tabs=None):
    parts = []
    if back:
        parts.append(f'<a class="back" href="{back[0]}">{ic("chevron-left")}{back[1]}</a>')
    av = f'{avatar}' if avatar else ''
    text = f'<div class="page-title-row"><h1 class="t-title">{title}</h1>{labels}</div>'
    if desc: text += f'<p class="page-desc">{desc}</p>'
    if meta: text += f'<div class="page-meta">{meta}</div>'
    parts.append(f'<div class="page-head"><div class="page-head-main">{av}<div class="page-head-text">{text}</div></div>{f"<div class=\"actions\">{actions}</div>" if actions else ""}</div>')
    if tabs:
        t = ''.join(f'<a class="tab" href="#"{" aria-current=\"page\"" if cur else ""}>{l}{f"<span class=\"count\">{c}</span>" if c is not None else ""}</a>' for l, c, cur in tabs)
        parts.append(f'<nav class="tabs" aria-label="Views">{t}</nav>')
    return '<header class="page-header">' + ''.join(parts) + '</header>'

def command(items_html, placeholder='Search or run a command'):
    return f'''<div class="scrim command-scrim" id="command" hidden>
  <div class="command" role="dialog" aria-modal="true" aria-label="Search">
    <div class="command-input">{ic('search')}<input type="text" placeholder="{placeholder}" aria-label="Search"></div>
    <div class="command-list" role="listbox">{items_html}</div>
    <div class="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd>Move</span><span><kbd>↵</kbd>Open</span><span><kbd>esc</kbd>Close</span></div>
  </div>
</div>'''

def confirm(id_, title, text, action, toast):
    return f'''<div class="scrim" id="{id_}" hidden>
  <div class="modal modal-sm modal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="{id_}-t" aria-describedby="{id_}-d">
    <div class="modal-head"><span class="avatar avatar-danger">{ic('trash')}</span><div class="overlay-heading"><div class="overlay-title" id="{id_}-t">{title}</div><div class="overlay-desc" id="{id_}-d">{text}</div></div></div>
    <div class="modal-foot"><button class="btn" type="button" data-close autofocus>Cancel</button><button class="btn btn-danger-solid" type="button" data-close data-toast="{toast}">{action}</button></div>
  </div>
</div>'''

# ----------------------------------------------------------------------- Competitor Intel frame
INTEL_CMD = command(f'''<div class="nav-label">Companies</div>
      <a class="item" aria-current="true" href="page-record.html"><span class="avatar avatar-xs">SC</span>StoriiCare<span class="count">Seniorverse Day</span></a>
      <a class="item" href="page-record.html"><span class="avatar avatar-xs">CB</span>Collabrios<span class="count">Seniorverse Day</span></a>
      <div class="nav-label">Actions</div>
      <button class="item" type="button">{ic('plus')}Add a competitor</button>
      <button class="item" type="button">{ic('search')}Run a survey</button>
      <a class="item" href="page-form.html">{ic('folder')}New project</a>''')

def intel(current, main, overlays=''):
    def nav(href, icon, label, key, count=None):
        cur = ' aria-current="page"' if key == current else ''
        c = f'<span class="count">{count}</span>' if count else ''
        return f'<a class="item" href="{href}"{cur}>{ic(icon)}{label}{c}</a>'
    def proj(href, ini, label, key):
        cur = ' aria-current="page"' if key == current else ''
        return f'<a class="item" href="{href}"{cur}><span class="avatar avatar-xs">{ini}</span>{label}</a>'
    return f'''<div class="app">
  <nav class="sidebar-nav" aria-label="Competitor Intel">
    <div class="menu-wrap w-full">
      <button class="switcher" type="button" data-toggle aria-haspopup="menu" aria-expanded="false"><span class="avatar avatar-sm avatar-accent">{ic('radar')}</span><span class="switcher-name">Competitor Intel</span>{ic('chevrons-up-down')}</button>
      <div class="menu menu-start" role="menu" hidden>
        <div class="menu-head"><span class="t-label">Seniorverse apps</span></div>
        {item('external', 'Company OS', 'href="#"', tag='a')}
        {item('clipboard', 'Assessment Builder', 'href="page-sidebar.html"', tag='a')}
      </div>
    </div>
    <button class="search-btn" type="button" data-open="command">{ic('search')}Search<kbd>⌘K</kbd></button>
    <div class="nav-list">
      {nav('page-dashboard.html', 'layout-grid', 'Home', 'home')}
      {nav('page-activity.html', 'activity', 'Activity', 'activity', '5')}
      <div class="nav-label">Projects<a class="btn btn-icon btn-quiet btn-sm" href="page-form.html" aria-label="New project">{ic('plus', 'icon icon-sm')}</a></div>
      {proj('page-list.html', 'SD', 'Seniorverse Day', 'day')}
      {proj('page-list.html', 'SH', 'Seniorverse Home Care', 'home-care')}
    </div>
    <div class="sidebar-foot">
      {nav('page-settings.html', 'settings', 'Settings', 'settings')}
      <div class="menu-wrap w-full">
        <button class="item" type="button" data-toggle aria-haspopup="menu" aria-expanded="false"><span class="avatar avatar-xs">SL</span>Sam Lee{ic('chevrons-up-down', 'icon icon-sm end')}</button>
        <div class="menu menu-start menu-up" role="menu" hidden>
          <div class="menu-head"><span class="t-small muted">sam@example.com</span></div>
          {item('help-circle', 'Help')}
          <div class="menu-sep"></div>
          {item('log-out', 'Sign out')}
        </div>
      </div>
    </div>
  </nav>
  <div class="panel">
    <div class="mobile-bar"><button class="btn btn-icon btn-quiet menu-btn" type="button" aria-label="Open navigation">{ic('menu')}</button>Competitor Intel</div>
{main}
  </div>
</div>
{INTEL_CMD}
{overlays}'''

# ======================================================================= collection page
companies = [
    ('Us', 'SV', 'Seniorverse', 'seniorverse.com', '', '1,015', 'Oct 18', status('running', 'Collecting'), True),
    ('Competitors', 'SC', 'StoriiCare', 'storiicare.com', '<span class="label">Full study</span>', '1,842', 'Oct 17', status('success', 'Up to date'), False),
    ('Competitors', 'WS', 'WellSky Adult Day', 'wellsky.com', '<span class="label">Full study</span>', '2,410', 'Oct 2', status('success', 'Up to date'), False),
    ('Competitors', 'CB', 'Collabrios', 'collabrios.com', '<span class="label">Light profile</span>', '214', 'Oct 12', status('danger', '1 failed'), False),
    ('Competitors', 'CW', 'CareWatch', 'carewatch.com', '<span class="label">Light profile</span>', '96', 'None', status('neutral', 'Queued'), False),
    ('Competitors', 'TP', 'Turning Point Systems', 'No website yet', '<span class="label label-outline">Not studied</span>', '0', 'None', '<span class="status neutral">Not studied</span>', False),
]
COLS = 'minmax(0, 1fr) 72px 96px 128px 32px'

def crow(c):
    _, ini, name, site, labels, facts, last, st, us = c
    acts = item('play', 'Collect again') + item('arrow-up-right', 'Upgrade to full study') + '<div class="menu-sep"></div>' + item('x', 'Remove from project', f'data-toast="{name} removed|Still in other projects" data-undo="true"', danger=True)
    return f'''    <div class="row">
      <div class="row-lead"><span class="row-pick"><input type="checkbox" data-row-check aria-label="Select {name}"><span class="avatar{" avatar-accent" if us else ""}">{ini}</span></span><div class="row-main"><span class="row-title"><a class="row-link" href="page-record.html">{name}</a>{labels}</span><span class="row-sub">{site}</span></div></div>
      <span class="row-cell num">{facts}</span><span class="row-cell">{last}</span><span class="row-cell">{st}</span>
      <div class="row-end row-hover">{more_menu(acts, f"Actions for {name}", quiet=True, sm=True)}</div>
    </div>'''

rows, last_group = [], None
for c in companies:
    if c[0] != last_group:
        n = sum(1 for x in companies if x[0] == c[0])
        rows.append(f'    <div class="row-group">{c[0]}<span class="count">{n}</span></div>')
        last_group = c[0]
    rows.append(crow(c))

cards = '\n'.join(f'''    <a class="card" href="page-record.html"><div class="card-body stack">
      <div class="cluster"><span class="avatar{" avatar-accent" if c[8] else ""}">{c[1]}</span><span class="row-main"><span class="row-title">{c[2]}</span><span class="row-sub">{c[3]}</span></span></div>
      <div class="cluster">{c[4] or '<span class="label label-accent">Us</span>'}{c[7]}</div>
      <div class="page-meta"><span><b>{c[5]}</b> facts</span><span>Changed {c[6]}</span></div>
    </div></a>''' for c in companies)

filter_pop = f'''<div class="menu-wrap">
        <button class="btn btn-sm" type="button" data-toggle aria-haspopup="dialog" aria-expanded="false">{ic('filter')}Filter</button>
        <div class="popover popover-wide" role="dialog" aria-label="Filters" hidden>
          <div class="popover-section"><span class="t-label">Study</span>
            <label class="item option option-check"><input type="checkbox">Full study<span class="count">2</span></label>
            <label class="item option option-check"><input type="checkbox">Light profile<span class="count">2</span></label>
            <label class="item option option-check"><input type="checkbox">Not studied<span class="count">1</span></label>
          </div>
          <div class="popover-section"><span class="t-label">Status</span>
            <label class="item option option-check"><input type="checkbox">Collecting<span class="count">1</span></label>
            <label class="item option option-check"><input type="checkbox">Up to date<span class="count">2</span></label>
            <label class="item option option-check"><input type="checkbox">Has failures<span class="count">1</span></label>
          </div>
          <div class="popover-foot"><button class="btn btn-sm btn-quiet" type="button">Clear all</button><button class="btn btn-sm" type="button" data-toggle-close>Done</button></div>
        </div>
      </div>'''

list_main = f'''    <main class="page">
      {header('Seniorverse Day',
        avatar='<span class="avatar avatar-lg">SD</span>',
        meta='<span>Adult day center software in the US</span><span>Compared against <a class="link" href="page-record.html">Seniorverse</a></span>',
        actions=more_menu(item('pencil', 'Edit project') + item('download', 'Export as CSV') + '<div class="menu-sep"></div>' + item('trash', 'Delete project', 'data-open="confirm-delete"', danger=True))
          + f'<button class="btn" type="button" data-toast="Survey started|It runs in the background">{ic("search")}Run survey</button>'
          + f'<button class="btn btn-primary" type="button" data-open="add-modal">{ic("plus")}Add competitor</button>',
        tabs=[('Competitors', 6, True), ('Find', 12, False), ('Compare', None, False), ('Changes', 4, False), ('Ask', None, False)])}
      <section class="stack">
        <div class="view-bar">
          <div class="views" aria-label="Views">
            <button class="view" type="button" aria-current="true">All<span class="count">6</span></button>
            <button class="view" type="button">Changed this week<span class="count">2</span></button>
            <button class="view" type="button">Needs attention<span class="count">1</span></button>
          </div>
          <span class="spacer"></span>
          {filter_pop}
          <div class="input-wrap">{ic('search')}<input class="input input-sm" type="search" placeholder="Search" aria-label="Search companies"></div>
          <div class="btn-group btn-group-sm" role="group" aria-label="Layout" data-view="#results"><button class="btn btn-icon" type="button" aria-pressed="true" data-value="list" aria-label="List">{ic('list')}</button><button class="btn btn-icon" type="button" aria-pressed="false" data-value="cards" aria-label="Cards">{ic('layout-grid')}</button></div>
        </div>
        <div id="results">
          <div class="list" data-selectable data-view-panel="list" style="--cols: {COLS}">
            <div class="list-header"><span>Company</span><span class="num">Facts</span><span>Last change</span><span>Status</span><span></span></div>
{chr(10).join(rows)}
            <div class="bulk-bar" data-bulk hidden><span data-selected-count>0 selected</span><button class="btn btn-sm" type="button">{ic('refresh')}Collect again</button><button class="btn btn-sm" type="button">{ic('arrow-up-right')}Full study</button><button class="btn btn-sm" type="button">{ic('x')}Remove</button></div>
          </div>
          <div class="grid-cards" data-view-panel="cards" hidden>
{cards}
          </div>
        </div>
      </section>
    </main>'''

add_modal = f'''<div class="scrim" id="add-modal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-t">
    <div class="modal-head"><div class="overlay-heading"><div class="overlay-title" id="add-t">Add a competitor</div><div class="overlay-desc">It is added to Seniorverse Day and studied right away.</div></div><button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">{ic('x')}</button></div>
    <div class="modal-body">
      <div class="form-row"><div class="field"><label class="field-label" for="am1">Name</label><input class="input" id="am1" placeholder="StoriiCare"></div><div class="field"><label class="field-label" for="am2">Website</label><input class="input" id="am2" placeholder="storiicare.com"></div></div>
      <div class="grid-2"><label class="choice-card"><input type="radio" name="aml" checked><span><span class="medium">Light profile</span><span class="check-desc">Key pages, read once</span></span></label><label class="choice-card"><input type="radio" name="aml"><span><span class="medium">Full study</span><span class="check-desc">Everything, re-checked</span></span></label></div>
    </div>
    <div class="modal-foot"><button class="btn btn-quiet" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-close data-toast="Competitor added|Collecting has started">Add competitor</button></div>
  </div>
</div>'''
page('page-list.html', 'Seniorverse Day · Competitor Intel', intel('day', list_main, add_modal + confirm('confirm-delete', 'Delete Seniorverse Day?', 'Its surveys, comparisons and digests are deleted. The companies and what was collected about them are kept.', 'Delete project', 'Seniorverse Day deleted')))

# ======================================================================= record page
def sec(id_, title, lead, meta, action, cites):
    return f'''        <section class="section" id="{id_}">
          <div class="section-head"><h2 class="section-title">{title}</h2><div class="actions"><span class="section-meta">{meta}</span>{action}</div></div>
          <p class="section-lead">{lead} {''.join(f'<button class="cite" type="button">{c}</button>' for c in cites)}</p>
          <div><button class="btn btn-sm btn-quiet align-start" type="button" data-reveal="{id_}-d" aria-expanded="false">{ic('chevron-right', 'icon icon-sm')}<span data-reveal-label>Show detail</span></button></div>
          <div class="reveal-body prose" id="{id_}-d" hidden><p>[The full section: lists, tables and citations, written from the facts collected.]</p></div>
        </section>'''

reviewed = '<span class="status success"><span class="status-dot"></span>Reviewed</span>'
mark = f'<button class="btn btn-sm" type="button" data-toast="Marked reviewed">{ic("check")}Mark reviewed</button>'
record_main = f'''    <main class="page page-wide">
      {header('StoriiCare', back=('page-list.html', 'Seniorverse Day'),
        avatar='<span class="avatar avatar-lg">SC</span>', labels='<span class="label">Full study</span>',
        meta=f'<a class="link" href="#">storiicare.com</a><span class="has-tip" tabindex="0">Collected 2 h ago<span class="tooltip" role="tooltip">Oct 19, 2026, 12:14 PM</span></span>{status("running", "Reading 14 items")}',
        actions=more_menu(item('pencil', 'Edit name and website') + item('upload', 'Add reviews or notes') + '<div class="menu-sep"></div>' + item('x', 'Remove from project', 'data-toast="StoriiCare removed|Still in other projects" data-undo="true"', danger=True))
          + f'<button class="btn" type="button" data-toast="Updating the profile">{ic("refresh")}Update profile</button>'
          + f'<button class="btn btn-primary" type="button" data-toast="Collecting again">{ic("play")}Collect again</button>',
        tabs=[('Profile', None, True), ('Timeline', 38, False), ('Facts', '1,842', False), ('Collected', 412, False), ('Sources', 6, False), ('Ask', None, False)])}
      <div class="with-aside">
        <div class="sections">
        <section class="section">
          <div class="section-head"><h2 class="section-title">Summary</h2><span class="section-meta">Written 2 h ago from 9 sections</span></div>
          <p class="section-lead">[Two or three sentences: what StoriiCare sells, to whom, and what stands out.] <button class="cite" type="button">112</button><button class="cite" type="button">87</button></p>
        </section>
        <section class="section">
          <div class="section-head"><h2 class="section-title">Against Seniorverse</h2></div>
          <div class="grid-3">
            <div class="stack-sm"><span class="t-label">They are stronger</span><ul class="bullets"><li>[Point from both profiles] <button class="cite" type="button">150</button></li><li>[Point from both profiles] <button class="cite" type="button">151</button></li></ul></div>
            <div class="stack-sm"><span class="t-label">We are stronger</span><ul class="bullets"><li>[Point from both profiles] <button class="cite" type="button">902</button></li></ul></div>
            <div class="stack-sm"><span class="t-label">To watch</span><ul class="bullets"><li>[Point from both profiles] <button class="cite" type="button">160</button></li></ul></div>
          </div>
        </section>
{sec('overview', 'Overview', '[Two-sentence lead from the section.]', '62 facts', reviewed, ['112'])}
{sec('products', 'Products and features', '[Two-sentence lead from the section.]', '211 facts', mark, ['140', '141'])}
{sec('pricing', 'Pricing', '[Two-sentence lead from the section.]', '14 facts', mark, ['301'])}
        <section class="section">
          <div class="section-head"><h2 class="section-title">Customers and market</h2><span class="section-meta">Not written yet</span></div>
          <p class="section-lead muted">No facts about customers yet. This is written once collected items name customers, counts or regions.</p>
        </section>
        </div>
        <aside class="aside" aria-label="Details">
          <div class="aside-block">
            <span class="t-label">Details</span>
            <dl class="properties">
              <dt>Status</dt><dd>{status('success', 'Up to date')}</dd>
              <dt>Study</dt><dd>Full study</dd>
              <dt>Facts</dt><dd>1,842</dd>
              <dt>Items</dt><dd>412</dd>
              <dt>Reviewed</dt><dd>1 of 9 sections</dd>
            </dl>
          </div>
          <div class="aside-block">
            <span class="t-label">At a glance</span>
            <dl class="properties">
              <dt>Sells</dt><dd>[From the profile] <button class="cite" type="button">112</button></dd>
              <dt>For</dt><dd>[From the profile] <button class="cite" type="button">87</button></dd>
              <dt>Price</dt><dd>[From the profile] <button class="cite" type="button">301</button></dd>
              <dt>Founded</dt><dd>[From the profile] <button class="cite" type="button">9</button></dd>
              <dt>Ownership</dt><dd class="faint">Not found</dd>
              <dt>HIPAA, SOC 2</dt><dd>[From the profile] <button class="cite" type="button">220</button></dd>
            </dl>
          </div>
          <div class="aside-block">
            <div class="section-head"><span class="t-label">Recent</span><a class="btn btn-sm btn-quiet" href="#">Timeline{ic('arrow-right', 'icon icon-sm')}</a></div>
            <ol class="timeline">
              <li class="timeline-item"><div class="timeline-mark"><span class="avatar avatar-sm">{ic('eye')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><span class="timeline-title">[A site change]</span><span class="timeline-meta">Seen by us</span></div><span class="timeline-date">Oct 17</span></li>
              <li class="timeline-item"><div class="timeline-mark"><span class="avatar avatar-sm">{ic('newspaper')}</span><span class="timeline-stem"></span></div><div class="timeline-body"><span class="timeline-title">[A reported event]</span><span class="timeline-meta">Partnership</span></div><span class="timeline-date">Sep</span></li>
            </ol>
          </div>
        </aside>
      </div>
    </main>'''
page('page-record.html', 'StoriiCare · Competitor Intel', intel('day', record_main))

# ======================================================================= form page
form_main = f'''    <main class="page">
      {header('New project', back=('page-list.html', 'Projects'), desc='A project is one market and the companies in it. Everything here can be changed later.')}
      <div class="notice danger" role="alert">{ic('alert-triangle')}<div class="notice-body"><span class="notice-title">Two things need fixing.</span><span><a class="link" href="#nf-market">Describe the market</a> and <a class="link" href="#nf-site">check the website address</a>.</span></div></div>
      <form class="form">
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Basics</div><div class="fieldset-desc">The survey searches from the market description; comparisons use it too.</div></div>
          <div class="fieldset-body">
            <div class="field"><label class="field-label" for="nf-name">Project name</label><input class="input" id="nf-name" value="Seniorverse Home Care"></div>
            <div class="field"><label class="field-label" for="nf-market">The market</label><textarea class="input" id="nf-market" aria-invalid="true" aria-describedby="nf-market-e" placeholder="Software for home care agencies in the US: scheduling, EVV, billing, caregiver apps."></textarea><div class="field-error" id="nf-market-e">{ic('alert-circle', 'icon icon-sm')}Describe the market in a sentence or two</div></div>
          </div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Compare against</div><div class="fieldset-desc">Usually your own company.</div></div>
          <div class="fieldset-body"><div class="form-row">
            <div class="field"><label class="field-label" for="nf-us">Company</label><input class="input" id="nf-us" value="Seniorverse"></div>
            <div class="field"><label class="field-label" for="nf-site">Website</label><input class="input" id="nf-site" value="seniorverse" aria-invalid="true" aria-describedby="nf-site-e"><div class="field-error" id="nf-site-e">{ic('alert-circle', 'icon icon-sm')}Enter a full address, like seniorverse.com</div></div>
          </div></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Competitors<span class="optional">Optional</span></div><div class="fieldset-desc">Add the ones you know. The survey finds more.</div></div>
          <div class="fieldset-body">
            <div class="form-row-action"><div class="field"><label class="field-label" for="nf-c1">Name</label><input class="input" id="nf-c1" value="AxisCare"></div><div class="field"><label class="field-label" for="nf-c1s">Website</label><input class="input" id="nf-c1s" value="axiscare.com"></div><button class="btn btn-icon btn-quiet" type="button" aria-label="Remove AxisCare">{ic('x')}</button></div>
            <div><button class="btn btn-sm" type="button">{ic('plus')}Add another</button></div>
          </div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">How deep to go</div><div class="fieldset-desc">For the competitors above.</div></div>
          <div class="fieldset-body">
            <div class="grid-2"><label class="choice-card"><input type="radio" name="nf-l" checked><span><span class="medium">Light profile</span><span class="check-desc">Key pages only, read once</span></span></label><label class="choice-card"><input type="radio" name="nf-l"><span><span class="medium">Full study</span><span class="check-desc">Whole site, news, history, re-checked</span></span></label></div>
            <fieldset class="field"><legend class="field-label mb-2">Repeat the survey</legend><div class="check-list"><label class="check"><input type="radio" name="nf-r" checked>Every month</label><label class="check"><input type="radio" name="nf-r">Every 3 months</label><label class="check"><input type="radio" name="nf-r">Only when asked</label></div></fieldset>
          </div>
        </div>
      </form>
      <div class="save-bar"><span>Not created yet</span><div class="actions"><a class="btn btn-quiet" href="page-list.html">Cancel</a><button class="btn btn-primary" type="button">Create project</button></div></div>
    </main>'''
page('page-form.html', 'New project · Competitor Intel', intel('none', form_main))

# ======================================================================= settings
settings_main = f'''    <main class="page">
      {header('Settings', desc='For everyone using Competitor Intel.', tabs=[('General', None, True), ('Collecting', None, False), ('Connections', None, False), ('Notifications', None, False), ('Access', None, False)])}
      <form class="form">
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Display</div><div class="fieldset-desc">How dates and the theme are shown.</div></div>
          <div class="fieldset-body"><div class="form-row">
            <div class="field"><span class="field-label" id="tz-l">Time zone</span>{select('tz-l', 'Eastern time', ['Eastern time', 'Central time', 'Mountain time', 'Pacific time'])}</div>
            <div class="field"><span class="field-label" id="th-l">Theme</span>{select('th-l', 'Match this device', ['Match this device', 'Light', 'Dark'])}</div>
          </div></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Collecting</div><div class="fieldset-desc">How politely and how much the crawler reads. A site's robots.txt can ask for longer; it is always honored.</div></div>
          <div class="fieldset-body"><div class="form-row">
            <div class="field"><label class="field-label" for="s1">Between requests to one site</label><div class="input-affix"><input class="input num" id="s1" value="5"><span class="affix">seconds</span></div></div>
            <div class="field"><label class="field-label" for="s2">Most pages per site</label><div class="input-affix"><input class="input num" id="s2" value="600"><span class="affix">pages</span></div></div>
          </div></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Connections</div><div class="fieldset-desc">Keys are set on the app in Astrodock and never shown here.</div></div>
          <div class="fieldset-body"><div class="list">
            <div class="row"><div class="row-lead"><span class="avatar">{ic('activity')}</span><div class="row-main"><span class="row-title">AI · Amazon Bedrock</span><span class="row-sub">Reading, profiles, comparisons</span></div></div>{status('success', 'Connected')}</div>
            <div class="row"><div class="row-lead"><span class="avatar">{ic('search')}</span><div class="row-main"><span class="row-title">Search · Perplexity</span><span class="row-sub">$5 per 1,000 requests</span></div></div>{status('success', 'Connected')}</div>
            <div class="row" style="--cols: minmax(0, 1fr) auto auto"><div class="row-lead"><span class="avatar">{ic('mail')}</span><div class="row-main"><span class="row-title">Inbound email</span><span class="row-sub">Needs INTEL_EMAIL_DOMAIN</span></div></div>{status('warning', 'Needs setup')}<a class="btn btn-sm" href="page-wizard.html">Set up</a></div>
          </div></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title">Notifications</div><div class="fieldset-desc">These apply as soon as they are switched.</div></div>
          <div class="fieldset-body stack-sm">
            <button class="switch" type="button" role="switch" aria-checked="true" data-toast="Weekly digest on"><span class="switch-track"></span>Email me the weekly digest</button>
            <button class="switch" type="button" role="switch" aria-checked="false" data-toast="Change alerts on"><span class="switch-track"></span>Email me notable changes</button>
          </div>
        </div>
        <div class="fieldset">
          <div class="fieldset-intro"><div class="fieldset-title text-danger">Danger zone</div><div class="fieldset-desc">These cannot be undone.</div></div>
          <div class="fieldset-body"><div class="cluster"><button class="btn btn-danger" type="button" data-open="confirm-archive">Delete archived copies</button><span class="t-small muted">The timeline loses its archive entries.</span></div></div>
        </div>
      </form>
      <div class="save-bar"><span>Unsaved changes</span><div class="actions"><button class="btn btn-quiet" type="button">Discard</button><button class="btn btn-primary" type="button" data-toast="Settings saved">Save changes</button></div></div>
    </main>'''
page('page-settings.html', 'Settings · Competitor Intel', intel('settings', settings_main, confirm('confirm-archive', 'Delete 1,204 archived copies?', 'The copies and the timeline entries made from them are deleted for every company.', 'Delete copies', 'Archived copies deleted')))

# ======================================================================= dashboard
DAYS = ['Oct 6', 'Oct 7', 'Oct 8', 'Oct 9', 'Oct 10', 'Oct 11', 'Oct 12', 'Oct 13', 'Oct 14', 'Oct 15', 'Oct 16', 'Oct 17', 'Oct 18', 'Oct 19']
WORK = [(180, 120), (240, 210), (90, 110), (310, 260), (205, 150), (60, 40), (40, 30), (212, 148), (318, 260), (146, 170), (262, 208), (96, 120), (301, 244), (152, 98)]
work_cols = [{'x': d, 'full': d, 'v': list(v), 'tick': k % 2 == 1} for k, (d, v) in enumerate(zip(DAYS, WORK))]
work_chart = chart('chartBlock', 'chart-work', {'label': 'Items collected and read per day, last 14 days', 'series': ['Collected', 'Read'], 'cols': work_cols, 'max': 600, 'ticks': [0, 200, 400, 600], 'periods': ['14 days', '30 days', '90 days']},
                   {'title': 'Work finished', 'value': '5,505', 'change': '12% on the 14 days before'})
spark = lambda vals, c=1: chart('sparkline', vals, c)

dash_main = f'''    <main class="page">
      {header('Good afternoon, Sam', desc='Across all projects. Updated just now.', actions=f'<a class="btn btn-primary" href="page-form.html">{ic("plus")}New project</a>')}
      <div class="stat-grid">
        <a class="stat" href="page-list.html"><div class="stat-label">Companies</div><div class="stat-value">9</div><div class="stat-sub">6 full · 3 light</div></a>
        <a class="stat" href="page-list.html"><div class="stat-label">To review</div><div class="stat-value">12</div><div class="stat-sub">{ic('trending-up', 'icon icon-sm')}5 new since yesterday</div>{spark([3, 5, 4, 6, 7, 7, 12])}</a>
        <a class="stat" href="page-list.html"><div class="stat-label">Notable changes</div><div class="stat-value">4</div><div class="stat-sub">Last 7 days</div>{spark([1, 0, 2, 1, 0, 3, 4], 3)}</a>
        <a class="stat" href="page-activity.html"><div class="stat-label">Spent this month</div><div class="stat-value">$61.40</div><div class="stat-sub">AI $58.20 · Search $3.20</div>{spark([12, 19, 24, 31, 40, 52, 61], 2)}</a>
      </div>
      <div class="with-aside">
        <div class="sections">
          <section class="section">
            {work_chart}
          </section>
          <section class="section">
            <div class="section-head"><h2 class="section-title">Projects</h2></div>
            <div class="grid-2">
              <a class="card" href="page-list.html"><div class="card-body stack"><div class="cluster"><span class="avatar">SD</span><span class="row-main"><span class="row-title">Seniorverse Day</span><span class="row-sub">Adult day centers</span></span></div><div class="page-meta"><span><b>6</b> companies</span><span><b>12</b> to review</span></div></div></a>
              <a class="card" href="page-list.html"><div class="card-body stack"><div class="cluster"><span class="avatar">SH</span><span class="row-main"><span class="row-title">Seniorverse Home Care</span><span class="row-sub">Home care agencies</span></span></div><div class="page-meta"><span><b>3</b> companies</span>{status('running', 'Survey running')}</div></div></a>
            </div>
          </section>
        </div>
        <aside class="aside">
          <div class="aside-block">
            <span class="t-label">Needs attention</span>
            <div class="list">
              <a class="row" href="page-activity.html"><div class="row-lead"><span class="avatar avatar-sm avatar-danger">{ic('alert-triangle')}</span><div class="row-main"><span class="row-title">3 jobs failed</span><span class="row-sub">Writing the StoriiCare profile…</span></div></div>{ic('chevron-right', 'icon faint')}</a>
              <a class="row" href="page-wizard.html"><div class="row-lead"><span class="avatar avatar-sm avatar-warning">{ic('mail')}</span><div class="row-main"><span class="row-title">Email not set up</span><span class="row-sub">Mailing lists are skipped</span></div></div>{ic('chevron-right', 'icon faint')}</a>
              <a class="row" href="page-list.html"><div class="row-lead"><span class="avatar avatar-sm">{ic('inbox')}</span><div class="row-main"><span class="row-title">12 candidates</span><span class="row-sub">From the Oct 18 survey</span></div></div>{ic('chevron-right', 'icon faint')}</a>
            </div>
          </div>
          <div class="aside-block">
            <span class="t-label">Running now</span>
            <div class="progress-item"><div class="progress-head"><span>Crawling storiicare.com</span><span>132 / 412</span></div><div class="progress" style="--value: 32%"><span></span></div></div>
            <div class="progress-item"><div class="progress-head"><span>History of collabrios.com</span><span>40 / 211</span></div><div class="progress" style="--value: 19%"><span></span></div></div>
          </div>
        </aside>
      </div>
    </main>'''
page('page-dashboard.html', 'Home · Competitor Intel', intel('home', dash_main))

# ======================================================================= activity
def worker(job, company, progress, time):
    return f'<div class="row" style="--cols: minmax(0, 1fr) auto"><div class="row-lead"><span class="avatar avatar-sm avatar-soft"><span class="spinner"></span></span><div class="row-main"><span class="row-title">{job}<span class="faint">·</span><span class="muted">{company}</span></span><span class="row-sub">{progress}</span></div></div><span class="row-meta num">{time}</span></div>'

act_main = f'''    <main class="page page-wide">
      {header('Activity', desc='Background work in two lanes. Every AI call and search is recorded with its cost.', tabs=[('Now', None, True), ('History', '2,318', False), ('Usage and cost', None, False)])}
      <div class="grid-2">
        <section class="stack-sm">
          <div class="section-head"><h2 class="section-title">Collecting</h2><span class="section-meta">2 of 3 busy · 4 waiting</span></div>
          <div class="list">
            {worker('Crawl pages', 'StoriiCare', 'Page 7 of 20 · storiicare.com/pricing', '1:12')}
            {worker('Read archived copies', 'Collabrios', 'Copy 3 of 10 · collabrios.com/pricing, Apr 2021', '0:48')}
          </div>
        </section>
        <section class="stack-sm">
          <div class="section-head"><h2 class="section-title">Reading and writing</h2><span class="section-meta">3 of 4 busy · 210 waiting</span></div>
          <div class="list">
            {worker('Read an item', 'StoriiCare', 'Pulling facts, part 2 of 3', '0:22')}
            {worker('Date facts', 'Seniorverse', '12 facts in a press release', '0:09')}
            {worker('Write the profile', 'Collabrios', 'Pricing, 3 of 9', '2:04')}
          </div>
        </section>
      </div>
      <section class="stack-sm">
        <div class="section-head"><h2 class="section-title">Failed this week</h2><button class="btn btn-sm" type="button" data-toast="2 jobs queued again">{ic('refresh')}Retry all</button></div>
        <div class="table-box flush"><table class="table">
          <thead><tr><th>Job</th><th>For</th><th>Error</th><th class="num">Attempts</th><th>When</th><th class="actions-col"><span class="sr-only">Retry</span></th></tr></thead>
          <tbody>
            <tr class="clickable" data-open="job-drawer"><td class="primary">Write the profile<span class="cell-sub">#4176</span></td><td>StoriiCare</td><td>The reply was cut off at the token limit</td><td class="num">3</td><td class="nowrap">1:58 PM</td><td class="actions-col"><button class="btn btn-sm" type="button" data-toast="Queued again">Retry</button></td></tr>
            <tr class="clickable" data-open="job-drawer"><td class="primary">Collect news<span class="cell-sub">#4090</span></td><td>Collabrios</td><td>Search rate limit reached</td><td class="num">3</td><td class="nowrap">Yesterday</td><td class="actions-col"><button class="btn btn-sm" type="button" data-toast="Queued again">Retry</button></td></tr>
          </tbody>
        </table></div>
      </section>
    </main>'''
drawer = f'''<div class="scrim drawer-scrim" id="job-drawer" hidden>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="jd-t">
    <div class="drawer-head"><div class="overlay-heading"><span class="t-label">Job #4176</span><div class="overlay-title" id="jd-t">Write the profile</div>{status('danger', 'Failed after 3 attempts')}</div><button class="btn btn-icon btn-quiet btn-sm overlay-close" type="button" data-close aria-label="Close">{ic('x')}</button></div>
    <div class="drawer-body">
      <div class="notice danger">{ic('alert-triangle')}<div class="notice-body"><span class="notice-title">The reply was cut off at the token limit.</span><span>Retrying writes the section again from the same facts.</span></div></div>
      <dl class="properties"><dt>For</dt><dd><span class="avatar avatar-xs">SC</span>StoriiCare</dd><dt>Queued</dt><dd>Oct 19, 1:55 PM</dd><dt>Took</dt><dd>2 min 4 s</dd><dt>AI calls</dt><dd>4 · $0.61 estimated</dd></dl>
      <div class="stack-sm"><span class="t-label">AI calls</span><div class="table-box flush"><table class="table table-compact"><thead><tr><th>Purpose</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody><tr><td>Overview</td><td class="num">18.2k</td><td class="num">1.1k</td><td class="num">$0.09</td></tr><tr><td>Pricing</td><td class="num">9.4k</td><td class="num">32.0k</td><td class="num">$0.68</td></tr></tbody></table></div></div>
      <div class="stack-sm"><span class="t-label">Input</span><pre class="code-block">{{ "companyId": 2, "force": false }}</pre></div>
    </div>
    <div class="drawer-foot"><button class="btn" type="button" data-close>Close</button><button class="btn btn-primary" type="button" data-close data-toast="Queued again">Retry</button></div>
  </aside>
</div>'''
page('page-activity.html', 'Activity · Competitor Intel', intel('activity', act_main, drawer))

# ======================================================================= wizard
wiz_main = f'''    <main class="page page-narrow">
      {header('Set up mailing lists', back=('page-settings.html', 'Settings'), desc='Each company gets its own address to sign up to their newsletters with.')}
      <ol class="steps" aria-label="Steps"><li class="done"><span>Choose a domain</span></li><li aria-current="step"><span>Point its mail here</span></li><li><span>Test it</span></li><li><span>Review</span></li></ol>
      <section class="card">
        <div class="card-head"><div><h2 class="card-title">Point mail for <span class="mono">intel-mail.example.com</span> here</h2><div class="card-sub">Add these records where the domain's DNS is managed. This page checks every minute.</div></div></div>
        <div class="card-body stack">
          <div class="table-box flush"><table class="table table-compact">
            <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Found</th><th class="actions-col"><span class="sr-only">Copy</span></th></tr></thead>
            <tbody>
              <tr><td>MX</td><td class="mono">intel-mail</td><td class="mono">inbound.mail.example</td><td>{status('success', 'Found')}</td><td class="actions-col"><button class="btn btn-sm btn-quiet btn-icon" type="button" data-toast="Copied" aria-label="Copy">{ic('copy')}</button></td></tr>
              <tr><td>TXT</td><td class="mono">intel-mail</td><td class="mono">v=spf1 include:mail.example ~all</td><td>{status('neutral', 'Not yet')}</td><td class="actions-col"><button class="btn btn-sm btn-quiet btn-icon" type="button" data-toast="Copied" aria-label="Copy">{ic('copy')}</button></td></tr>
            </tbody>
          </table></div>
        </div>
        <div class="card-foot"><button class="btn btn-quiet start" type="button">{ic('chevron-left')}Back</button><span class="t-small muted">Checked 20 s ago</span><span class="has-tip"><button class="btn btn-primary" type="button" disabled>Next: test it</button><span class="tooltip" role="tooltip">Waiting for the TXT record</span></span></div>
      </section>
    </main>'''
page('page-wizard.html', 'Set up mailing lists · Competitor Intel', intel('settings', wiz_main))

# ======================================================================= queue (Assessment Builder)
queue = [
    ('JM', '6-month assessment', 'Participant 1042 · Maple Center', '2h', '<span class="label">Submitted</span>', True, True),
    ('AR', 'Fall risk screen', 'Participant 0988 · Maple Center', '5h', '<span class="label">Submitted</span>', True, False),
    ('JM', 'Intake', 'Participant 1101 · Oak Center', 'Yesterday', status('warning', '2 missing answers'), False, False),
    ('KT', '6-month assessment', 'Participant 0871 · Oak Center', 'Oct 16', '<span class="label">Resubmitted</span>', False, False),
    ('AR', 'Nutrition screen', 'Participant 0790 · Maple Center', 'Oct 15', '<span class="label">Submitted</span>', False, False),
]
q_items = '\n'.join(f'''          <a class="queue-item{' current' if cur else ''}" href="#"{' aria-current="true"' if cur else ''}>
            <span class="avatar">{a}</span>
            <span class="queue-item-body"><span class="queue-item-top">{'<span class="dot" aria-label="New"></span>' if new else ''}<span class="queue-item-title">{t}</span><span class="queue-item-time">{tm}</span></span><span class="queue-item-sub">{s}</span><span class="queue-item-tags">{tags}</span></span>
          </a>''' for a, t, s, tm, tags, new, cur in queue)

queue_body = f'''<div class="app">
  <nav class="sidebar-nav" aria-label="Assessment Builder">
    <div class="menu-wrap w-full">
      <button class="switcher" type="button" data-toggle aria-haspopup="menu" aria-expanded="false"><span class="avatar avatar-sm avatar-accent">{ic('clipboard')}</span><span class="switcher-name">Assessment Builder</span>{ic('chevrons-up-down')}</button>
      <div class="menu menu-start" role="menu" hidden><div class="menu-head"><span class="t-label">Seniorverse apps</span></div>{item('external', 'Company OS', 'href="#"', tag='a')}{item('radar', 'Competitor Intel', 'href="page-dashboard.html"', tag='a')}</div>
    </div>
    <button class="search-btn" type="button" data-open="command">{ic('search')}Search<kbd>⌘K</kbd></button>
    <div class="nav-list">
      <a class="item" href="#">{ic('layout-grid')}Home</a>
      <a class="item" href="#" aria-current="page">{ic('inbox')}To review<span class="count">8</span></a>
      <a class="item" href="#">{ic('flag')}Flagged<span class="count">2</span></a>
      <div class="nav-label">Build</div>
      <a class="item" href="#">{ic('clipboard')}Assessments</a>
      <a class="item" href="#">{ic('file')}Question bank</a>
      <div class="nav-label">Results</div>
      <a class="item" href="#">{ic('users')}Participants</a>
      <a class="item" href="#">{ic('bar-chart')}Reports</a>
    </div>
    <div class="sidebar-foot">
      <a class="item" href="#">{ic('settings')}Settings</a>
      <div class="menu-wrap w-full"><button class="item" type="button" data-toggle aria-haspopup="menu" aria-expanded="false"><span class="avatar avatar-xs">SL</span>Sam Lee{ic('chevrons-up-down', 'icon icon-sm end')}</button><div class="menu menu-start menu-up" role="menu" hidden>{item('log-out', 'Sign out')}</div></div>
    </div>
  </nav>
  <div class="panel">
    <div class="mobile-bar"><button class="btn btn-icon btn-quiet menu-btn" type="button" aria-label="Open navigation">{ic('menu')}</button>Assessment Builder</div>
    <div class="split">
      <section class="queue" aria-label="To review">
        <div class="queue-head">
          <div class="queue-title"><h1 class="t-heading">To review</h1><span class="count">8</span><span class="spacer"></span><button class="btn btn-icon btn-quiet btn-sm" type="button" aria-label="Filter">{ic('filter')}</button></div>
          <div class="input-wrap">{ic('search')}<input class="input input-sm" type="search" placeholder="Search" aria-label="Search submissions"></div>
          <nav class="tabs" aria-label="Queue views"><a class="tab" href="#" aria-current="page">Waiting<span class="count">8</span></a><a class="tab" href="#">Sent back<span class="count">3</span></a><a class="tab" href="#">Approved</a></nav>
        </div>
        <div class="queue-list">
{q_items}
        </div>
        <div class="queue-foot"><span><kbd>J</kbd><kbd>K</kbd>Move</span><span><kbd>A</kbd>Approve</span><span><kbd>S</kbd>Send back</span></div>
      </section>
      <section class="detail" aria-label="Submission">
        <div class="detail-bar">
          <div class="btn-group btn-group-sm" role="group" aria-label="Move"><button class="btn btn-icon" type="button" aria-label="Previous" disabled>{ic('chevron-up')}</button><button class="btn btn-icon" type="button" aria-label="Next">{ic('chevron-down')}</button></div>
          <span class="detail-pos">1 of 8</span>
          <span class="spacer"></span>
          {more_menu(item('flag', 'Flag for later') + item('copy', 'Copy link') + '<div class="menu-sep"></div>' + item('trash', 'Discard', danger=True), quiet=True, sm=True)}
          <button class="btn btn-sm" type="button" data-toast="Sent back|The nurse is asked to confirm mobility">{ic('undo')}Send back</button>
          <button class="btn btn-sm btn-primary" type="button" data-toast="Approved|Next submission opened">{ic('check')}Approve</button>
        </div>
        <div class="detail-body">
          <div class="page-head"><div class="page-head-main"><span class="avatar avatar-lg">JM</span><div class="page-head-text"><div class="page-title-row"><h2 class="t-title">6-month assessment</h2><span class="label">Submitted</span></div><div class="page-meta"><span>Participant 1042</span><span>Maple Center</span><span>Jordan Moss · 2h ago</span></div></div></div></div>
          <section class="stack">
            <div class="section-head"><h3 class="section-title">Scores</h3><span class="section-meta">Compared with April</span></div>
            <dl class="kv">
              <dt>Mobility</dt><dd class="cluster">[Answer]{status('warning', 'Lower than April')}</dd>
              <dt>Cognition</dt><dd>[Answer]</dd>
              <dt>Nutrition</dt><dd>[Answer]</dd>
              <dt>Notes</dt><dd class="empty-value">None</dd>
            </dl>
          </section>
          <hr>
          <section class="stack">
            <div class="section-head"><h3 class="section-title">Discussion</h3></div>
            <div class="thread">
              <div class="comment event"><span class="avatar avatar-sm">{ic('activity')}</span><div class="comment-body">Submitted by Jordan Moss · 2h ago</div></div>
              <div class="comment"><span class="avatar avatar-sm">SL</span><div><div class="comment-head"><b>Sam Lee</b><span>1h ago</span></div><div class="comment-body">Mobility is lower than April. Can we confirm before approving?</div></div></div>
              <div class="composer"><label class="sr-only" for="reply">Reply</label><textarea id="reply" placeholder="Reply…"></textarea><div class="composer-foot"><span>Mention with @</span><button class="btn btn-sm btn-primary" type="button" data-toast="Reply sent">Send</button></div></div>
            </div>
          </section>
        </div>
      </section>
    </div>
  </div>
</div>
{command(f'<div class="nav-label">Participants</div><a class="item" aria-current="true" href="#"><span class="avatar avatar-xs">P</span>Participant 1042<span class="count">Maple Center</span></a><a class="item" href="#"><span class="avatar avatar-xs">P</span>Participant 0988<span class="count">Maple Center</span></a><div class="nav-label">Actions</div><button class="item" type="button">{ic("plus")}New assessment</button><button class="item" type="button">{ic("download")}Export results</button>', 'Search participants and actions')}'''
page('page-sidebar.html', 'To review · Assessment Builder', queue_body)

# ======================================================================= docs frame (kit pages)
DOCS = [
    ('index.html', 'layout-grid', 'Overview'), ('foundations.html', 'eye', 'Foundations'), ('components.html', 'list', 'Components'),
]
SAMPLES = [
    ('page-list.html', 'Collection'), ('page-record.html', 'Record'), ('page-form.html', 'Create'), ('page-settings.html', 'Settings'),
    ('page-dashboard.html', 'Dashboard'), ('page-activity.html', 'Background work'), ('page-wizard.html', 'Step by step'),
    ('page-sidebar.html', 'Queue'), ('page-states.html', 'Sign-in and errors'), ('mobile.html', 'On a phone'),
]

def docs(current, main):
    d = ''.join(f'<a class="item" href="{h}"{" aria-current=\"page\"" if h == current else ""}>{ic(i)}{l}</a>' for h, i, l in DOCS)
    s = ''.join(f'<a class="item" href="{h}"{" aria-current=\"page\"" if h == current else ""}>{l}</a>' for h, l in SAMPLES)
    return f'''<div class="app" data-docs>
  <nav class="sidebar-nav" aria-label="Design system">
    <div class="switcher"><span class="avatar avatar-sm avatar-accent">{ic('layout-grid')}</span><span class="switcher-name">Astrodock UI</span></div>
    <div class="nav-list">{d}<div class="nav-label">Page types</div>{s}</div>
    <div class="sidebar-foot"><div class="btn-group btn-group-sm" role="group" aria-label="Theme"><button class="btn" type="button" data-theme-set="light">{ic('sun', 'icon icon-sm')}Light</button><button class="btn" type="button" data-theme-set="dark">{ic('moon', 'icon icon-sm')}Dark</button></div></div>
  </nav>
  <div class="panel">
    <div class="mobile-bar"><button class="btn btn-icon btn-quiet menu-btn" type="button" aria-label="Open navigation">{ic('menu')}</button>Astrodock UI</div>
{main}
  </div>
</div>'''

# ---- index
principles = [
    ('Content leads', 'One quiet frame; the page is a single white panel. Titles, data and the main action come first.'),
    ('One way to do each thing', 'One button, one select, one list, one checkbox. A screen never invents a control.'),
    ('Fewer boxes', 'Structure from type, space and hairlines. Cards only for things that are objects.'),
    ('Color means something', 'The accent is the primary action, focus and checked. Green, amber and red mean what they say.'),
    ('Always a way back', 'A back link names the parent; the URL keeps the tab, view and filters.'),
    ('Every state designed', 'Loading, empty, no matches, error, no access, running: each has a set look and words.'),
]
pr = ''.join(f'<div class="stack-sm"><span class="medium">{a}</span><span class="t-small muted">{b}</span></div>' for a, b in principles)
links = ''.join(f'<a class="card" href="{h}"><div class="card-body stack-sm"><span class="medium">{l}</span><span class="t-small muted">{d}</span></div></a>' for h, l, d in [
    ('foundations.html', 'Foundations', 'Color, type, space, radius, depth, icons.'),
    ('components.html', 'Components', 'Every part with its markup.'),
    ('page-list.html', 'Collection', 'Views, filter, list, bulk actions.'),
    ('page-record.html', 'Record', 'Sections and a properties column.'),
    ('page-form.html', 'Create', 'Grouped fields and the save bar.'),
    ('page-sidebar.html', 'Queue', 'Working through items one by one.'),
])
index_main = f'''    <main class="page">
      <header class="page-header"><div class="page-head-text">
        <span class="t-label">Astrodock · packages/ui</span>
        <h1 class="t-display">How Astrodock apps are built</h1>
        <p class="page-desc page-desc-lg">One quiet, precise system for every app on the platform. Tokens make primitives, primitives make components, components make page types, and every screen is one of the page types.</p>
      </div></header>
      <div class="sections">
        <section class="section"><div class="section-head"><h2 class="section-title">Principles</h2></div><div class="grid-3">{pr}</div></section>
        <section class="section"><div class="section-head"><h2 class="section-title">Start here</h2></div><div class="grid-3">{links}</div></section>
        <section class="section"><div class="section-head"><h2 class="section-title">For agents building an app</h2></div>
          <p class="section-lead">Read REFERENCE.md for the markup of every part and README.md for the rules. Start each screen from a page type. After changing the kit, run <span class="mono">node scripts/check.js</span> and <span class="mono">node scripts/build-reference.js</span>.</p></section>
      </div>
    </main>'''
page('index.html', 'Astrodock app design system', docs('index.html', index_main))

# ---- foundations
def swatches(items):
    return '<div class="swatches">' + ''.join(f'<div class="swatch"><div class="swatch-chip" style="--swatch: var(--{t})"></div><div class="swatch-body"><b>{n}</b>--{t}</div></div>' for n, t in items) + '</div>'
f_main = f'''    <main class="page">
      {header('Foundations', desc='Tokens are the only values in the system. An app changes its brand by changing tokens. Switch the theme in the sidebar: every swatch is live.')}
      <div class="sections">
        <section class="section"><div class="section-head"><h2 class="section-title">Neutrals</h2><span class="section-meta">Zinc. The frame, the panel, and every shade of text and line.</span></div>
          {swatches([('Frame', 'bg-frame'), ('Page', 'bg-page'), ('Subtle', 'bg-subtle'), ('Sunken', 'bg-sunken'), ('Active', 'bg-active'), ('Line', 'line'), ('Line input', 'line-input'), ('Ink 4', 'ink-4'), ('Ink 3', 'ink-3'), ('Ink 2', 'ink-2'), ('Ink', 'ink')])}</section>
        <section class="section"><div class="section-head"><h2 class="section-title">Accent and meaning</h2><span class="section-meta">The accent is for the primary action, focus and checked marks only.</span></div>
          {swatches([('Accent', 'accent'), ('Accent soft', 'accent-soft'), ('Success', 'success'), ('Warning', 'warning'), ('Danger', 'danger'), ('Series 1', 'series-1'), ('Series 2', 'series-2'), ('Series 3', 'series-3')])}</section>
        <section class="section"><div class="section-head"><h2 class="section-title">Type</h2><span class="section-meta">Geist and Geist Mono. Three weights: 400, 500, 600.</span></div>
          <div class="stack">
            <div class="type-row"><span class="t-label">Display 32</span><span class="t-display">How apps are built</span></div>
            <div class="type-row"><span class="t-label">Title 24</span><span class="t-title">StoriiCare</span></div>
            <div class="type-row"><span class="t-label">Heading 16</span><span class="t-heading">Against Seniorverse</span></div>
            <div class="type-row"><span class="t-label">Section 14</span><span class="section-title">Pricing</span></div>
            <div class="type-row"><span class="t-label">Body 14</span><span>The deep dive reads the whole site, then writes the profile from the facts it finds.</span></div>
            <div class="type-row"><span class="t-label">Small 13</span><span class="t-small muted">Collected 2 h ago · 412 items</span></div>
            <div class="type-row"><span class="t-label">Label 12</span><span class="t-label">Last change</span></div>
            <div class="type-row"><span class="t-label">Mono</span><span class="mono">job #4182 · intel.apps.example.com</span></div>
          </div></section>
        <section class="section"><div class="section-head"><h2 class="section-title">Radius and depth</h2><span class="section-meta">Three radii. Avatars are rounded squares.</span></div>
          <div class="cluster">{''.join(f'<div class="stack-sm"><span class="radius-demo" style="--r: var(--radius-{r})"></span><span class="t-xs muted">--radius-{r} · {u}</span></div>' for r, u in [('xs', 'marks'), ('sm', 'controls'), ('md', 'surfaces')])}</div></section>
        <section class="section"><div class="section-head"><h2 class="section-title">Space</h2><span class="section-meta">A 4px scale.</span></div>
          <div class="stack-sm">{''.join(f'<div class="scale-row"><code>--space-{n}</code><span class="scale-bar" style="--size: var(--space-{n})"></span></div>' for n in [1, 2, 3, 4, 5, 6, 8, 10, 12, 16])}</div></section>
      </div>
    </main>'''
page('foundations.html', 'Foundations · Astrodock UI', docs('foundations.html', f_main))

# ---- components (rendered from the catalog, with an On this page column)
def esc(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

CATALOG = kit_js('(w) => w.KIT_CATALOG')
toc, secs, n = [], [], 0
for g in CATALOG:
    toc.append(f'<div class="nav-label">{g["group"]}</div>')
    for c in g['components']:
        toc.append(f'<a href="#{c["id"]}">{c["title"]}</a>')
        use = ''
        if c.get('use') or c.get('notFor'):
            use = '<div class="catalog-use">' + (f'<span><b>Use for</b> {c["use"]}</span>' if c.get('use') else '') + (f'<span><b>Not for</b> {c["notFor"]}</span>' if c.get('notFor') else '') + '</div>'
        exs = []
        for ex in c['examples']:
            n += 1
            desc = f'<span class="t-small muted">{ex["desc"]}</span>' if ex.get('desc') else ''
            exs.append(f'''<div class="specimen">
            <div class="specimen-head"><span class="medium">{ex["title"]}</span>{desc}<span class="spacer"></span><button class="btn btn-sm btn-quiet" type="button" data-reveal="code-{n}" aria-expanded="false">{ic('chevron-right', 'icon icon-sm')}<span data-reveal-label>Show markup</span></button></div>
            <div class="specimen-demo">{ex["html"]}</div>
            <div class="specimen-code" id="code-{n}" hidden><pre class="code-block">{esc(ex["html"])}</pre><button class="btn btn-sm" type="button" data-copy="code-{n}" data-toast="Markup copied">{ic('copy', 'icon icon-sm')}Copy</button></div>
          </div>''')
        secs.append(f'''        <section class="section" id="{c["id"]}">
          <div class="section-head"><h2 class="t-heading">{c["title"]}</h2></div>
          <p class="section-lead">{c["lede"]}</p>
          {use}
          {''.join(exs)}
        </section>''')
comp_main = f'''    <main class="page page-wide">
      <header class="page-header"><div class="page-head"><div class="page-head-main"><div class="page-head-text"><div class="page-title-row"><h1 class="t-title">Components</h1></div><p class="page-desc">Every part, its examples and when to use it. Show markup reveals the canonical markup; REFERENCE.md is built from the same catalog.</p></div></div></div></header>
      <div class="with-toc">
        <div class="sections">
{chr(10).join(secs)}
        </div>
        <nav class="toc" aria-label="On this page">{''.join(toc)}</nav>
      </div>
    </main>'''
page('components.html', 'Components · Astrodock UI', docs('components.html', comp_main))

# ---- states
def frame(label, desc, inner):
    return f'''        <section class="section"><div class="section-head"><h2 class="section-title">{label}</h2><span class="section-meta">{desc}</span></div><div class="frame">{inner}</div></section>'''
states_main = f'''    <main class="page">
      {header('Sign-in, errors, loading', desc='Each says what happened in plain words and offers one way forward.')}
      <div class="sections">
{frame('Signing in', 'The moment between Astrodock\'s sign-in and the app.', f'<div class="center"><div class="empty"><span class="avatar avatar-xl avatar-accent">{ic("radar")}</span><div class="empty-title">Competitor Intel</div>{status("running", "Signing you in")}</div></div>')}
{frame('No access', 'Who is signed in, and who can grant access.', f'<div class="center"><div class="empty"><span class="avatar avatar-xl">{ic("lock")}</span><div class="empty-title">You don\'t have access</div><p class="empty-text">You\'re signed in as sam@example.com. An administrator can give you access in Astrodock.</p><div class="actions actions-center"><button class="btn" type="button">Switch account</button><a class="btn btn-primary" href="#">Back to Company OS</a></div></div></div>')}
{frame('Not found', 'Keep people moving.', f'<div class="center"><div class="empty"><span class="avatar avatar-xl">{ic("file-question")}</span><div class="empty-title">This company isn\'t here</div><p class="empty-text">It may have been removed, or the link may be wrong.</p><a class="btn" href="page-list.html">Go to projects</a></div></div>')}
{frame('Something went wrong', 'What failed, nothing lost, what to do, a reference.', f'<div class="center"><div class="empty"><span class="avatar avatar-xl avatar-danger">{ic("alert-triangle")}</span><div class="empty-title">This page could not load</div><p class="empty-text">The server did not answer. Nothing you entered was lost. Reference <span class="mono">req 7f3a-19c2</span></p><div class="actions actions-center"><button class="btn" type="button" data-toast="Reference copied">{ic("copy")}Copy reference</button><button class="btn btn-primary" type="button">Try again</button></div></div></div>')}
{frame('First use', 'One sentence and the first step. No tour.', f'<div class="center"><div class="empty"><span class="avatar avatar-xl avatar-soft">{ic("radar")}</span><div class="empty-title">Start with a project</div><p class="empty-text">A project is one market. Describe it, add the competitors you know, and the app finds the rest.</p><a class="btn btn-primary btn-lg" href="page-form.html">{ic("plus")}New project</a></div></div>')}
{frame('Loading', 'Skeletons shaped like what is coming.', '<div class="page"><div class="stack-sm"><span class="skeleton skeleton-title" style="--w: 240px"></span><span class="skeleton" style="--w: 360px"></span></div><div class="list">' + ''.join(f'<div class="row"><div class="row-lead"><span class="skeleton skeleton-avatar"></span><div class="row-main w-full"><span class="skeleton" style="--w: {a}%"></span><span class="skeleton" style="--w: {b}%"></span></div></div></div>' for a, b in [(30, 55), (24, 48), (34, 40)]) + '</div></div>')}
      </div>
    </main>'''
page('page-states.html', 'Sign-in, errors, loading · Astrodock UI', docs('page-states.html', states_main))

# ---- mobile
mobile_main = f'''    <main class="page page-wide">
      {header('On a phone', desc='The same pages at 390px. The sidebar hides behind the menu button; columns and side panels stack; controls grow; dialog buttons fill the width.')}
      <div class="phone-row">
        <div class="stack-sm"><div class="phone"><iframe src="page-list.html" title="Collection on a phone"></iframe></div><span class="phone-caption">Collection</span></div>
        <div class="stack-sm"><div class="phone"><iframe src="page-record.html" title="Record on a phone"></iframe></div><span class="phone-caption">Record</span></div>
        <div class="stack-sm"><div class="phone"><iframe src="page-form.html" title="Create on a phone"></iframe></div><span class="phone-caption">Create</span></div>
        <div class="stack-sm"><div class="phone"><iframe src="page-sidebar.html" title="Queue on a phone"></iframe></div><span class="phone-caption">Queue</span></div>
      </div>
    </main>'''
page('mobile.html', 'On a phone · Astrodock UI', docs('mobile.html', mobile_main))
print('pages written')
