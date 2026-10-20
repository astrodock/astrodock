# Astrodock app design system

How every app on an Astrodock platform is built and how it looks: the frame, the page types, how people move around, what every state looks like, how the words read, and the parts pages are made of. An agent building an app follows this file; a person who knows one app finds the next one works the same way.

**Status: preview for review.** What exists: the stylesheet, the rules (this file), the markup reference, the preview pages and the checker. Not built yet: the React components named below (`@astrodock/ui/react`) and the starter app's move onto them.

| File | What it is |
|---|---|
| `README.md` | The rules: principles, structure, navigation, page types, states, interaction, writing |
| `REFERENCE.md` | Copy-ready markup for tokens, shells, the page header and every component. Generated; do not edit |
| `kit.css` | Every style, in layers: tokens, base, primitives, components, layout |
| `preview/catalog.js` | The one source for every component's examples: the components page and REFERENCE.md are built from it |
| `preview/index.html` | Open in a browser: overview and links to every preview page |
| `preview/page-*.html` | One page per page type, built only from kit classes |
| `scripts/check.js` | Fails on raw values in kit.css, classes the kit does not define, inline styles, native selects |
| `scripts/build-reference.js` | Rebuilds REFERENCE.md |
| `scripts/build-preview.py` | Writes the preview pages (`python3 scripts/build-preview.py`, Python 3.12 or later). Edit it, not the generated HTML |
| `scripts/shoot.js` | Screenshots of the preview pages for checking a change (needs playwright-core) |

**Building an app with it (agents):** read `REFERENCE.md` for markup and this file for rules. Start every screen from a page type, copy the markup for its parts, and keep app CSS to tokens and app-specific layout.

**Changing the kit:** change `kit.css` (tokens first), add or change the example in `preview/catalog.js`, then run `python3 scripts/build-preview.py && node scripts/check.js && node scripts/build-reference.js`. A new component goes into the catalog before any app uses it.

---

## How it builds on itself

| Layer | What | Rule |
|---|---|---|
| 1. Tokens | Every color, size, radius, weight, shadow, layer and duration | The only place values appear. Apps change tokens, never rules |
| 2. Base | Element defaults, focus ring, icons, checkboxes and radios | One checkbox and one radio look everywhere |
| 3. Primitives | Control (button, input, select trigger), item (menu row, option, nav row), surface (card, table, stat), avatar, count, text roles | Components are built from these; a menu option and a nav row are the same item |
| 4. Components | Buttons, fields, select, menus, lists, view bar, sections, modals, toasts... | Built only from primitives and tokens |
| 5. Layout and page types | App frame (sidebar and panel), page, page header, columns, split view | Every screen is one page type |

**The look:** quiet and precise. A soft gray frame holds the sidebar; the page sits on one white panel. Inside it, structure comes from type, whitespace and hairlines, not boxes. Cards are for things that are objects (a project, a stat, a chart), never for wrapping a section. Current and selected states are neutral; the accent is kept for the primary button, focus and checked marks. Type is Geist and Geist Mono.

**Shape:** `--radius-xs` (5px) for marks (checkbox, citation, kbd, small avatars), `--radius-sm` (8px) for controls, items and avatars, `--radius-md` (12px) for surfaces: the panel, cards, popovers, modals, drawers, toasts. Avatars are rounded squares, never circles. Only things that move along a track are round: switches, radios, progress, spinners, dots.

**Weights:** 400 text, 500 navigation, labels and meta, 600 titles. Buttons, tabs, menus and labels are 13px; body and inputs 14px.

**Spacing:** space between siblings always comes from the parent's gap (`.page`, `.stack`, `.sections`), never from a margin on "the one after". That rule is what keeps cards in a grid aligned.

---

## Principles

1. **Content leads.** One quiet frame; the page is a single white panel. The title, what matters and the main action are visible without scrolling.
2. **One way to do each thing.** One select, one modal, one way to filter, one place for page actions. A screen never invents its own control.
3. **You always know where you are and how to get back.** Every page below a section's first level has a back button naming its parent. The URL holds the tab, filters and sort, so back, reload and a shared link all land in the same place.
4. **Actions are buttons; navigation is links.** A button does something. A link goes somewhere and opens in a new tab when asked.
5. **Fewer boxes.** Sections separate by space and a hairline, not by cards and shadows. Borders are kept for inputs.
6. **Color means something.** The accent is the primary action, focus and checked marks. Green, amber and red mean success, attention and failure, always with a word.
7. **Every state is designed.** Loading, nothing yet, no matches, error, no access, and working in the background each have a set look and set words.
8. **Nothing is lost by accident.** Unsaved changes are guarded. Deletes can be undone, or are confirmed when they cannot. Long work runs in the background and shows progress.

---

## Building an app

An Astrodock app is `app/` (Vite and React) plus `server/` (Express, routes under `/api`). See `examples/starter-app/AGENTS.md` for the platform contract. The frontend is laid out like this:

```
app/src/
  main.tsx            imports @astrodock/ui/kit.css, then theme.css; mounts <App/>
  theme.css           the app's token overrides (brand only); may be empty
  App.tsx             <AppShell> with the sections, and the routes
  lib/api.ts          fetch wrapper (401 sends to sign-in) and a useLoad hook
  lib/format.ts       dates, numbers, money, plurals (rules under Writing)
  screens/            one file per page; each starts from a page type below
  components/         app-specific pieces built from kit components
```

Rules:
- Load `kit.css` once, first. App CSS may set tokens and lay out app-specific pieces; it never restyles a kit component.
- Every page uses one of the page types below, unchanged in anatomy.
- Every control comes from the kit. If something is missing, add it to the kit, not to the app.
- Load the fonts with `<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">`, or leave them out and the system font is used.
- Set `data-theme` on `<html>`: `light`, `dark`, or `auto` (follows the device). Default `auto`.

### React components (planned: `@astrodock/ui/react`)

| Component | Covers |
|---|---|
| `AppFrame`, `Sidebar` | The gray frame, the sidebar (switcher, search, sections, person) and the white panel; the phone menu |
| `Page`, `PageHeader`, `BackButton` | Page width, back button, title row, meta line, actions |
| `Tabs` | Tabs synced to `?tab=` |
| `Button`, `IconButton`, `ButtonGroup` | Kinds, sizes, working state |
| `Menu`, `MenuItem` | Actions menus, the account menu |
| `Field`, `Input`, `Textarea`, `InputAffix` | Labels, hints, errors |
| `Select`, `MultiSelect` | Listbox with hints, search, groups; never a native select |
| `Checkbox`, `Radio`, `ChoiceCard`, `Switch` | Choice controls |
| `FileDrop` | Upload with progress |
| `List`, `Row`, `Table`, `BulkBar`, `Card` | Showing records |
| `ViewBar`, `FilterButton`, `FilterSidebar` | Views, filters, search, sort and layout, synced to the URL |
| `Sections`, `Section`, `Properties` | The structure of record and settings pages |
| `KeyValue`, `Stat`, `Status`, `Label`, `Avatar`, `Progress`, `Timeline` | Showing values |
| `Queue`, `Thread`, `Composer`, `CommandMenu` | Queues, discussion, Cmd+K |
| `Modal`, `Confirm`, `Drawer` | Overlays with focus handling and Escape |
| `Toast` (`toast()`), `Notice`, `EmptyState`, `Skeleton`, `Spinner`, `Tooltip` | Feedback |
| `BarChart`, `LineChart` | Charts following the chart rules |
| `useUnsavedChanges`, `useUrlState` | Guarding forms; keeping tab, filters and sort in the URL |

---

## The shell

**App frame (every app).** The sidebar sits on the gray frame; the page sits on one white panel beside it.
- **Sidebar, top to bottom:** the switcher (the app's avatar and name; it opens the other apps), a search button that opens the command menu (Cmd+K), the sections with icons and counts, then labeled groups of records people go to often (projects, queues), and at the bottom Settings and the account menu (who is signed in, Your account, theme, help, sign out).
- **Current section:** a white fill with a hairline, the same shape as the panel.
- **On a phone:** the sidebar hides behind a menu button in a slim bar at the top of the panel.
- **Section nav:** when one area has many parts (a component index, settings groups, help articles), a second column at the panel's left edge lists them (`.with-subnav`, `.subnav`; rows are `.item`). It marks the part in view and hides under 1100px.

**Page width.** Two only. Full (`.page`) fills the panel, with the gutter at each side: collections, records, dashboards, background work, queues. Narrow (`.page page-narrow`, 880px) for forms, settings and step-by-step pages, where long lines and wide fields slow people down. Reading text keeps its own line length (70 characters) inside either. A record page whose main column is reading text uses `.with-aside.reading`: the column stops at 70 characters, so section heads and their actions line up with the text, and the properties column sits beside it.

Nothing else is permanent chrome: no footer, no second bar, no banner unless something needs setup (then a notice in the page that is affected). The CSS keeps a top-bar frame (`.app-topbar`) for one-screen tools; everything else uses the sidebar.

---

## Navigation and URLs

The hierarchy is **section → collection → record → tab**. URLs follow it:

```
/projects                     section root (collection)
/projects/12                  record
/projects/12?tab=compare      a tab of the record
/projects/12?tab=find&fit=3   tab plus its filters
/companies/7                  a record reached from several places
```

- **Back button** on every page below a section root, top left, naming the parent ("← Seniorverse Day"). It goes to the parent, not to browser history, and restores the parent's filters from the URL. A record reachable from several places names its main parent.
- **No breadcrumbs.** The back button and the shell's active section say where you are. If a hierarchy needs breadcrumbs, it is too deep.
- **Tabs** are part of the URL (`?tab=`). The first tab is the default and has no parameter.
- **Filters, sort and search** are in the URL. Paging is not.
- **Links are real links** (`<a href>`): middle-click and Cmd-click open a new tab. Rows that open a record are links.
- **After create**, go to the new record. **After delete**, go to the parent with a toast.
- **Opening another app** (for example the company OS) opens a new tab.

---

## Page types

Every screen is one of these. Each has a preview page.

### 1. Collection page (`preview/page-list.html`)
A set of records to find, scan and act on.
- **Header:** back link if not a section root; avatar, title, one line of context; actions: the primary "Add …" last, rare actions in More. Tabs below when the record has views.
- **View bar:** saved views on the left with counts ("All", "Changed this week", "Needs attention"); on the right the Filter button (a panel of checkbox groups; a badge shows how many are set), search, and list or cards.
- **List:** columns set once and named once in a header row; each row is the avatar, the name with its labels and one line of context, aligned values, status as a dot and a word, and its More button on hover. Group labels when the list has natural parts. The whole row opens the record. A table instead when people compare many values. Load more at the end; no numbered pages.
- **Selection:** hovering a row turns its avatar into a checkbox; selecting brings up the bulk bar floating at the bottom of the window.
- **Filter sidebar** only on pages people filter constantly (history, logs).
- **Empty:** "Nothing yet" (what goes here, how to start) differs from "No matches" (clear the filters).

### 2. Record page (`preview/page-record.html`)
One thing in detail.
- **Header:** back button naming the parent; title with a label for its type or level; meta line (key facts, freshness with the full time on hover, background work in progress); actions (main action primary, others plain, rare and destructive in More).
- **Tabs** under the header when the record has several views. Counts on tabs that hold lists.
- **First tab:** sections, not cards. Summary first, then the comparison, then each section with its lead and Show detail.
- **Properties column** on the right: the record's details and at-a-glance fields as a properties list, then recent activity. Values that run to a sentence use `.properties.stacked` (label above value). The column scrolls with the page. Moves below the content on narrow screens.

### 3. Create and edit (`preview/page-form.html`)
- **Five fields or fewer:** a modal. **More:** a page where each group has its title and one sentence on the left and its fields on the right, hairlines between groups (two short related fields may share a row).
- **Validation:** check a field when it is left, and everything on save. On a failed save, a notice at the top lists what needs fixing with links to the fields, and each field shows its own error.
- **Save:** the save bar floats at the bottom of the window once something changed: what changed, Discard, and the primary button named for the result ("Create project", "Save changes").
- **Leaving with changes** asks first ("Discard your changes?"), via `useUnsavedChanges`.
- **After save:** go to the record, toast "Saved".
- **Inline edit** only for a single obvious value (a name), never a group of fields.

### 4. Settings (`preview/page-settings.html`)
- A section root (no back button). Tabs for large areas; inside, the same grouped layout as forms, saved with the save bar.
- Switches apply at once with a toast and never sit in a group that needs Save.
- Connected services show their status, not their keys.
- **Danger zone** last: red title, each action explained, confirmation for anything that cannot be undone. Typing the name to confirm is kept for deleting large amounts of data.

### 5. Dashboard (`preview/page-dashboard.html`)
- Up to four stats, each linking to the list behind it, each with one line of context. "Needs attention" and "Running now" sit in the side column.
- A chart only when the trend matters; one chart per question.
- "Needs attention" lists what someone should act on (failures, setup missing, items to review), each row linking to where it is fixed.
- "Running now" with progress when the app does background work.
- No vanity numbers. If a number does not lead to an action, leave it off.

### 6. Background work (`preview/page-activity.html`)
For apps that run jobs (crawls, imports, AI work, sends).
- **Now:** each worker pool, what each worker is doing in words ("Page 7 of 20: storiicare.com/pricing"), how long it has run; what is waiting and how long the oldest has waited; recent failures with Retry and Retry all.
- **History:** a table with filters (status, type, record, search), newest first, with the total.
- **Detail** in a drawer: timings, attempts, input, result, the full error, the AI calls or requests it made with their cost, Retry or Cancel.
- **Usage and cost** when the work costs money: today, 7 and 30 days; per day by kind; breakdowns by purpose and record. Label estimates as estimates.
- Every record page that has work running says so in its meta line.

### 7. Step by step (`preview/page-wizard.html`)
Only when decisions must happen in order (setting up a domain, an import with mapping).
- Steps shown at the top; one decision per step; Back and Next in the footer; Next disabled with the reason shown until the step is done.
- Progress is saved: leaving and coming back resumes.
- A review step before anything is committed.
- Not for ordinary forms. If the steps do not depend on each other, it is a form.

### 8. System states (`preview/page-states.html`)
Not found, something went wrong, the app updating, offline, read-only, someone else changed it, partly done, slowed down, leaving with unsaved changes, first use, loading. Each: what happened in plain words, whether anything was lost, one way forward. Whole-page states keep the shell so people can carry on; the rest are notices at the top of what they affect.

### Sign-in and account (`preview/page-signin.html`)
Apps never build sign-in. Astrodock hosts it on the sign-in host (`auth.<domain>`) so an app never sees a password: sign in (password, passkey, Google), the authenticator-code step and recovery codes, joining from an invite, the account page, signed out, and the pages for when sign-in cannot go on. They are built from the same tokens as the kit, self-contained, with the app's accent and logo when it sets them. The preview frames are rendered from the control plane's code (`apps/control-plane/src/lib/auth-pages.js`, `account-page.js`, `routes/oauth.js`, `routes/invites.js`), so changing those pages means changing that code.

The app's part: the handoff screen while it starts the session, the account menu, "no access to this app", and the session-ended dialog (sign-in in a new window; nothing typed is lost).

### Sidebar shell and queue (`preview/page-sidebar.html`)
**Sidebar shell:** a white column with the app switcher (app avatar, name, organization) at the top, a search button that opens the command menu (Cmd+K), grouped sections with icons and counts, then settings, help and the person at the bottom.

**Queue (split view):** for working through items: reviewing, approving, triaging. The queue on the left has a title with its count, search, and tabs for its views; each item shows an avatar, title, time, one line of context and its labels, with a dot when new. The open item on the right has its own bar (position "1 of 8", previous and next, then its actions) and its detail and discussion below. Acting on an item opens the next. J and K move, A approves, S sends back.

---

## Components

When to use each, and when not. `preview/components.html` shows them.

| Component | Use for | Not for |
|---|---|---|
| Button, primary | The main action of a page, card or dialog. One in view | Navigation; secondary actions |
| Button, default | Other actions | |
| Button, quiet | Cancel; small actions inside rows | The main action |
| Button, danger | Deleting and removing | Anything reversible without consequence |
| Icon button | Close, more, refresh, menu: universal actions, always with an accessible name | Anything that needs a word to be understood |
| Segmented control | Switching views of the same data (list or cards, 7 or 30 days) | Filters (use the Filter button) |
| Menu | Rare actions, a row's third action onward, destructive actions away from the main one | Hiding the main action; navigation between sections |
| Text field | Short text | Choices from a known list |
| Textarea | Long text; grows to a limit then scrolls | |
| Prefix and suffix | Units ($, per month, participants) | Instructions |
| Select | One choice from about 4 to 10; options may carry a hint line | 2 or 3 choices that should be visible (radios) |
| Searchable select | Long lists: companies, people | |
| Multi-select | Several choices from a long list; shows two names then a count | Short lists (checkboxes in place) |
| Checkbox | Independent yes/no; filters | Settings that apply at once (switch) |
| Radio | One of 2 to 5, all visible | |
| Choice card | A choice with consequences people should read | Simple choices |
| Switch | A setting that applies when flipped, with a toast | Anything inside a form with Save |
| Date and time | The browser's own pickers, styled as fields | |
| File drop | Uploads: says accepted types and size; progress per file | |
| Section | The structure of a page: title, meta or action, content, hairline between | Wrapping in a card |
| Properties | A record's fields in its side column; "Not found" rather than blank | |
| Card | Things that are objects: a project, a stat, a chart | Wrapping sections; nesting |
| List | Records people scan and open: header row once, hairline rows, actions on hover | Repeated labels in rows; comparing many values (table) |
| Table | Comparing values across rows; sortable headers; numbers right-aligned | Two-column data (key-value) |
| Bulk bar | Acting on selected rows | |
| View bar | Views, Filter, search, layout above a collection | Rows of filter pills |
| Filter button | Filters in a panel, a badge for how many are set | |
| Comments | A record's discussion and history in one thread, composer last | |
| Key-value | A record's fields; "Not found" or "None" rather than blank | |
| Stat tile | The few numbers that matter, linking to the list behind them; a sparkline for direction | Every number available |
| Chart | One question per chart: the head gives the answer, the plot the shape. Bars for amounts, lines for trends | Pies, donuts, 3D, two y-axes |
| Bar list | A ranked breakdown with amount and share | Changes over time (chart) |
| Status | Done, Running, Queued, Needs setup, Failed: a dot (a spinner while running) and a word | Decoration |
| Label | Describing a record (level, role, draft) in neutral gray | Filters; buttons |
| Timeline | History, newest first, grouped by year; dates only as precise as known | |
| Show detail | Summary first, detail on demand | Hiding required information |
| Tabs | Views of one record | Steps; filters |
| Account menu | Who is signed in, Your account (on the sign-in host), theme, help, sign out; at the sidebar foot | App settings |
| Section nav | The parts of one area, in a column at the panel's left edge; marks the part in view | Moving between areas (the sidebar) |
| Filter sidebar | Pages filtered constantly (history, logs) | Ordinary collections (use the Filter button) |
| Modal | Short blocking tasks: up to five fields, a choice. Title and one line, the fields, actions on the right | Long forms; reading |
| Confirmation | Actions that cannot be undone: a small icon, the question, what will be lost, Cancel focused | Reversible actions (toast with Undo instead) |
| Command menu | Finding any record or action by typing (Cmd+K) | Replacing a page's own search |
| Drawer | A record's detail beside the list it came from | Editing large records (page) |
| Toast | Confirming an action that worked; Undo. Bottom right, one line with an icon, an optional second line, six seconds | Errors people must act on; anything to read later |
| Notice | A situation that persists: setup missing, read-only, a run stopped. Neutral or tinted, an icon, a first line in medium weight. No colored side bar | Confirmations |
| Empty state | Nothing yet (what goes here, how to start) or no matches (clear filters) | |
| Skeleton | Content loading, in the shape of what is coming | A blank page or a centered spinner |
| Spinner | A button working; a status that is running | Page loads |
| Progress | Long work with a known size; words beside it say what is happening | |
| Tooltip | An icon button's name, a full date, why a button is disabled | Anything needed to do the work |
| Avatar | People, companies and things: a rounded square with initials or an icon; accent for the app or "us"; in list rows it turns into the checkbox on hover | Circles |
| Citation | A small raised number after the claim it backs, numbered 1, 2, 3 in the order they appear. Several sources for one claim are one mark | Database ids as labels; a mark per source |

---

## States

| State | What it shows | Words |
|---|---|---|
| Loading a page | Shell and header at once; skeletons where content goes; after 10 s, "Still loading" | |
| Loading an action | The button keeps its label, adds a spinner, is disabled | |
| Nothing yet | Empty state with what will be here and the first step | "No competitors yet. Add the ones you know, or run a survey." |
| No matches | Empty state with the filters named and a Clear button | "No jobs match these filters." |
| Error loading | Inside the shell: what failed, nothing lost, Try again, a reference to send | "This page could not load." |
| Error saving | In place by the Save button; what was typed is kept | "Not saved: the connection dropped. Your changes are still here." |
| Field error | Under the field, saying how to fix it | "Enter a full address, like storiicare.com" |
| No access | Who is signed in, who can grant access, a way out | |
| Needs setup | A notice where the missing piece matters, saying what to set | |
| Working in the background | Status "Running" with words on what is happening; the page polls while it runs | "Page 7 of 20: storiicare.com/pricing" |
| Read-only | A notice saying why and who can change it | |
| Offline | A notice above the header; work stays on the page and saves when the connection is back | "You are offline." |
| App updating | Whole page, with a status that checks again; the page reloads itself | "Competitor Intel is updating" |
| Session ended | A dialog; signing in opens a new window so nothing typed is lost | "Sign in again to keep working" |
| Someone else changed it | A notice before saving over their edit: load theirs or save anyway | "Ann Ruiz changed this project 2 min ago." |
| Partly done | A notice naming what failed and what worked, with a retry for the rest | "2 of 14 could not be archived." |
| Slowed down | A notice where the work is; the work resumes by itself | "Too many searches at once." |
| Leaving with unsaved changes | A confirmation, only when something changed; Keep editing has focus | "Leave without saving?" |

---

## Interaction rules

**Saving and deleting**
- Save is explicit (a button), except switches, which apply at once.
- Reversible removals (remove from a project, dismiss, archive) happen at once with an Undo toast. No confirmation.
- Irreversible deletes ask first, name what goes and what stays, and use a red button named for the action ("Delete project"). Cancel has focus.
- Optimistic updates for small changes (marking reviewed, starring); roll back with an error toast on failure.

**Background work**
- Anything that can take more than a few seconds runs in the background. The button that starts it returns at once with a toast ("Survey started; it runs in the background").
- Pages showing running work poll every 3 to 6 seconds while something runs, and stop when nothing does.
- Progress is described in words, not only a bar.
- Failures are listed where people look (the record's meta line, Activity, the dashboard), each with Retry.

**Time, numbers, money**
- Relative times under two weeks ("2 h ago", "3 d ago"), dates after ("Oct 19" this year, "Oct 19, 2025" before), the full date and time on hover.
- Times in the person's time zone; "Today (UTC)" when a figure is grouped by UTC day.
- Numbers with thousands separators and tabular figures in tables. Money as "$4.18"; under a cent as "<$0.01"; estimates labeled "estimated".
- Dates known only to the month or year show only that ("Mar 2021", "2021").

**Keyboard and focus**
- Everything works with the keyboard. Focus is always visible.
- Escape closes the topmost menu, popover, modal or drawer. Enter submits a form; Cmd+Enter submits a long text box.
- `/` focuses the page's search when it has one. J and K move through a split view's list.
- A modal or drawer takes focus when it opens and returns it when it closes.

**Feedback timing**
- Under 100 ms: no indicator. Up to 1 s: the button's spinner. Longer: background work with progress.

---

## Writing

- Plain words, short sentences, sentence case everywhere ("Add competitor", not "Add Competitor").
- Buttons are a verb and what it acts on: "Run survey", "Delete project", "Upgrade to full study". Never "Submit", "OK", "Click here", "Yes".
- Titles name the thing ("StoriiCare"), not the screen ("Company detail").
- Errors say what happened and what to do, without blame or codes: "The server did not answer. Nothing you entered was lost. Try again in a moment."
- Empty states say what will be here and how to start.
- Labels are nouns; hints are one sentence; no instructions in placeholders.
- No exclamation marks, emoji, jokes or "Oops". No em-dashes. American English.
- Numbers as digits ("3 competitors"); "1 company", "2 companies".
- Say what the app does, not how it works inside, unless people need it to decide.

---

## Accessibility

- Text contrast at least 4.5:1, including small gray text. Tokens meet it in both themes.
- Color is never the only signal: status has an icon and a word; selected items also change weight or have a check.
- Every input has a visible label. Icon buttons have an accessible name.
- Real elements: `<button>` for actions, `<a href>` for navigation, `<input>` with `<label>`. Never a click handler on a `<div>`.
- Dialogs use `role="dialog"` (or `alertdialog` for confirmations), trap focus and return it.
- Touch targets at least 40px on a phone (the kit raises control height under 640px).
- Reduced-motion settings turn off animation.

---

## Theming and dark mode

An app's `theme.css` overrides tokens only:

```css
:root { --accent: #0f6fde; --accent-hover: #0b5bb8; --accent-ink: #0a4f9e; --accent-soft: #e8f1fc; }
:root[data-theme="dark"] { --accent: #5ea2f0; --accent-ink: #9cc6f7; --accent-soft: #14253b; }
```

- The default tokens are the Seniorverse theme: purple accent, zinc neutrals.
- Dark mode is its own set of values for the same tokens, chosen by hand, never inverted. An app that changes the accent sets both.
- Do not override neutrals or meaning colors per app.

---

## Charts

A chart answers one question. Copy the markup from REFERENCE.md (Charts); the catalog's helpers in `preview/catalog.js` show how it is computed.

- **Form.** Bars for amounts per day or week (stacked when the parts add to a total). Lines for trends and rates. A stat with a sparkline when one number says it. A bar list for a ranked breakdown. No pies, donuts or 3D.
- **Head.** The title, the headline number and its change in words ("12% on last week"), the period switch and the chart or table switch. The change is gray: up is not always good.
- **Series.** `--series-1` to `--series-5` in that order, then `--series-other`; fold anything past five into Other. A series keeps its color when filters change. Status colors are never series colors.
- **Marks.** Bars at most 24px wide with rounded tops; 2px gaps between stacked parts; 2px lines; points appear on hover with a ring.
- **Axes.** One y-axis, at most four gridlines, round tick values starting at 0. Label every other day when there are more than ten.
- **Reading values.** Every column has a tooltip (hover or tab): the full date, each series with its value, and the total. A table view for every chart. A legend whenever there are two series or more.
- **Text** uses the ink colors, never the series color.
- **Drawing.** HTML and CSS, so labels stay sharp at any width; SVG only for lines. Values arrive as custom properties (`--v` share of the axis, `--n` part of a stack, `--c` series color).
- The series colors pass a color-blindness separation check in both themes; the dark theme has its own steps. Green and yellow are below 3:1 contrast on white, so every chart keeps its tooltips and table view.

---

## Checklist for a new screen

- [ ] It is one of the page types, with that type's anatomy.
- [ ] Back link (if below a section root) names the parent and goes there.
- [ ] Sections, not cards; cards only for objects.
- [ ] Tab, filters, sort and search are in the URL.
- [ ] One primary action in view, named with a verb and object.
- [ ] Loading, nothing yet, no matches, error and no access are all handled.
- [ ] Destructive actions are undoable or confirmed.
- [ ] Forms validate on leave and on save, guard unsaved changes, and go to the record after save.
- [ ] Background work shows progress in words and polls only while running.
- [ ] Works at 390px wide.
- [ ] Keyboard only: every action reachable, focus visible, Escape closes overlays.
- [ ] Words follow the writing rules.
- [ ] No styles that restyle kit components; only tokens in `theme.css`.
