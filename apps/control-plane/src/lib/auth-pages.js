'use strict';

// The pages an app's end users see on the platform's own origin: the hosted
// sign-in, and the invite they redeem before they have one.
//
// Shared rather than copied, because the two are the same surface at two
// moments. When these lived inside the sign-in route, the invite page had the
// choice of importing a route file for its CSS or growing a second stylesheet
// that would drift from the first by the next change to either.
//
// Self-contained by design: no stylesheet request, no bundle, nothing from a
// third party. This renders before anything else an app owns has loaded, and a
// page with no dependencies is a page with a small attack surface. The one
// fetch is the Geist font, served by the platform itself (/_auth/geist.woff2).
//
// The look follows the Astrodock app design system (packages/ui/kit.css): the
// same neutrals, type, control sizes and radii, copied as values here because
// the kit's stylesheet is not loaded on this origin.

// Served as one self-contained document rather than the admin SPA: end users have
// no business loading the dashboard bundle, and a login page with no dependencies
// is a login page with a small attack surface.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Embedding data inside a <script> is not the same problem as embedding it in
// HTML, and the HTML escaper is actively wrong here: browsers do not decode
// entities inside a script block, so esc() produced `const CFG = {&quot;appId&quot;...}`
// — a syntax error that killed the entire inline script, and with it the sign-in
// form and the passkey button.
//
// What actually needs escaping is anything that could end the script element or
// be read as a line terminator. The result stays valid JSON.
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// A hex colour from the app record, or nothing. Validated rather than trusted:
// it is interpolated into a stylesheet, and "red;} body{display:none" is a
// perfectly good string.
function safeColor(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : null;
}

/**
 * Readable text on top of a given colour: white, or near-black.
 *
 * This exists because one brandColor is used in BOTH schemes while --accent-ink
 * flipped per scheme — #fff on light, #06120d on dark. An app with a dark brand
 * colour (Valise's spruce, #24443b) therefore got near-black text on a dark
 * green button in dark mode, which is unreadable. The ink has to follow the
 * colour it sits on, not the scheme around it.
 *
 * WCAG relative luminance, with the 0.179 threshold that maximizes the worse of
 * the two contrast ratios.
 */
function inkFor(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const chan = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  return L > 0.179 ? '#06120d' : '#fff';
}

const ICONS = {
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
};

/** A Lucide icon, inline: no sprite, no request. */
function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.alert}</svg>`;
}

/** The error line at the top of a form. Hidden until a script fills it. */
function errorLine() {
  return `<div class="err" id="err" role="alert" hidden>${icon('alert')}<span></span></div>`;
}

/** A password field with a Show button, so people can check what they typed. */
function passwordField(id, label, { autocomplete = 'current-password', hint = '', required = false, minlength = 0 } = {}) {
  return `<div class="field">
  <label for="${id}">${esc(label)}</label>
  <div class="pw"><input id="${id}" type="password" autocomplete="${autocomplete}"${required ? ' required' : ''}${minlength ? ` minlength="${minlength}"` : ''}><button class="reveal" type="button" data-reveal="${id}" aria-pressed="false">Show</button></div>
  ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
</div>`;
}

// The Show buttons on every page. Written as a string so each page's script can
// include it; it touches nothing but the field it names.
const REVEAL_JS = `document.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
  const f = document.getElementById(b.dataset.reveal);
  const on = f.type === 'password';
  f.type = on ? 'text' : 'password';
  b.textContent = on ? 'Hide' : 'Show';
  b.setAttribute('aria-pressed', String(on));
}));`;

function shell(title, body, { accent = null } = {}) {
  // Only when the app set one. With no brand colour the per-scheme defaults are
  // already chosen to suit their own scheme, and must not change.
  const ink = accent ? inkFor(accent) : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
@font-face{font-family:Geist;src:url(/_auth/geist.woff2) format('woff2');font-weight:100 900;font-display:swap}
:root{
  color-scheme:light dark;
  --frame:#f4f4f5; --surface:#fff; --sunken:#f4f4f5; --hover:#f4f4f5;
  --ink:#09090b; --ink-2:#3f3f46; --ink-3:#71717a; --ink-4:#a1a1aa;
  --line:#ececee; --line-input:#d4d4d8;
  --accent:${accent || '#0b7c56'}; --accent-ink:${ink || '#fff'};
  --danger-soft:#fdf0f0; --danger-ink:#991b1b; --success-soft:#ecfaf1; --success-ink:#166534;
  --card-shadow:0 0 0 1px rgba(9,9,11,.06),0 8px 24px -8px rgba(9,9,11,.10);
  --control-shadow:0 1px 2px rgba(9,9,11,.05);
}
@media(prefers-color-scheme:dark){:root{
  --frame:#09090b; --surface:#111113; --sunken:#1c1c1f; --hover:#1c1c20;
  --ink:#fafafa; --ink-2:#d4d4d8; --ink-3:#a1a1aa; --ink-4:#71717a;
  --line:#222226; --line-input:#34343a;
  --accent:${accent || '#2fe6a8'}; --accent-ink:${ink || '#06120d'};
  --danger-soft:#2c1414; --danger-ink:#fbb4b4; --success-soft:#0f2418; --success-ink:#a7f3c4;
  --card-shadow:0 0 0 1px rgba(255,255,255,.07),0 8px 24px -8px rgba(0,0,0,.6);
  --control-shadow:0 0 transparent;
}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 16px;
  background:var(--frame);color:var(--ink);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;font-feature-settings:'ss01'}
.card{width:100%;max-width:400px;padding:32px;border-radius:12px;background:var(--surface);box-shadow:var(--card-shadow);
  display:flex;flex-direction:column;gap:16px}
.mark,.brand-logo{display:block;margin:0 auto 4px}
.brand-logo{max-height:40px;max-width:180px;object-fit:contain}
.tile{display:grid;place-items:center;width:40px;height:40px;margin:0 auto 4px;border-radius:8px;background:var(--sunken);color:var(--ink-2)}
.tile.danger{background:var(--danger-soft);color:var(--danger-ink)}
.tile.success{background:var(--success-soft);color:var(--success-ink)}
.icon{width:16px;height:16px;flex:none}
.tile .icon{width:20px;height:20px}
.heading{display:flex;flex-direction:column;gap:6px;text-align:center}
h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em;line-height:1.25;text-align:center}
p{margin:0}
p.sub{color:var(--ink-3);text-align:center}
p.sub b,.who strong{color:var(--ink);font-weight:500}
form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:13px;font-weight:500;color:var(--ink-2)}
.hint{font-size:13px;color:var(--ink-3)}
input{width:100%;height:40px;padding:0 12px;border:0;border-radius:8px;background:var(--surface);color:inherit;font:inherit;
  box-shadow:inset 0 0 0 1px var(--line-input),var(--control-shadow);outline:none;transition:box-shadow .12s}
input:focus{box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
input[readonly]{background:var(--sunken);color:var(--ink-3)}
input.code{height:52px;font-size:24px;font-weight:500;letter-spacing:.32em;text-align:center;font-variant-numeric:tabular-nums}
.pw{position:relative}
.pw input{padding-right:64px}
.reveal{position:absolute;top:4px;right:4px;width:auto;height:32px;padding:0 10px;border:0;border-radius:6px;background:none;
  color:var(--ink-3);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.reveal:hover{background:var(--hover);color:var(--ink)}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:40px;padding:0 16px;border:0;border-radius:8px;
  background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:500;text-decoration:none;cursor:pointer;transition:background .12s,opacity .12s}
button:hover,a.btn:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
button:disabled{opacity:.6;cursor:default}
button:focus-visible,a:focus-visible,.reveal:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px}
button.secondary,a.secondary{background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-input),var(--control-shadow)}
button.secondary:hover,a.secondary:hover{background:var(--hover)}
button.quiet{width:auto;height:32px;padding:0 10px;background:none;color:var(--ink-3);font-size:13px}
button.quiet:hover{background:var(--hover);color:var(--ink)}
.alt{display:flex;flex-direction:column;gap:8px}
.split{display:flex;justify-content:space-between;gap:8px;margin:-4px -10px 0}
.err{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:8px;background:var(--danger-soft);color:var(--danger-ink);font-size:13px}
.err .icon{margin-top:2px}
.ok{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:8px;background:var(--success-soft);color:var(--success-ink);font-size:13px}
.muted{text-align:center;color:var(--ink-3);font-size:13px}
.who{text-align:center;color:var(--ink-2);font-size:13px}
/* A divider that says what the second option is, rather than a bare line. */
.or{display:flex;align-items:center;gap:12px;color:var(--ink-4);font-size:12px}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
.sec{display:flex;flex-direction:column;gap:12px;padding-top:16px;border-top:1px solid var(--line)}
.sec h2{margin:0;font-size:14px;font-weight:600}
.sec p{color:var(--ink-3);font-size:13px}
.state{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2)}
.dot{width:7px;height:7px;border-radius:999px;background:var(--ink-4)}
.dot.on{background:#16a34a}
.foot{margin:0;color:var(--ink-4);font-size:12px;text-align:center}
@media(max-width:480px){.card{padding:24px}input{font-size:16px}}
</style></head><body><main class="card">${body}</main><p class="foot">Protected by Astrodock</p></body></html>`;
}

/**
 * A page that ends the journey here: what happened, in a sentence, and the one
 * thing to do next when there is one. `icon` is a name from ICONS; `tone` is
 * neutral, danger or success.
 */
function errorPage(title, message, { icon: name = 'alert', tone = 'neutral', action = null } = {}) {
  const tile = `<span class="tile${tone === 'neutral' ? '' : ` ${tone}`}">${icon(name)}</span>`;
  const next = action && /^(\/|https?:\/\/)/.test(action.href)
    ? `<a class="btn secondary" href="${esc(action.href)}">${esc(action.label)}</a>` : '';
  return shell(title, `${tile}<div class="heading"><h1>${esc(title)}</h1><p class="sub">${esc(message)}</p></div>${next}`);
}

/**
 * The app's logo, or the platform mark as a fallback.
 *
 * Only https, and no referrer: the platform should not tell a third party who
 * is signing in to what, merely because someone pasted a logo URL.
 */
function brandMark(logoUrl, appName) {
  const logo = /^https:\/\/[^\s"'<>]+$/.test(String(logoUrl || '')) ? String(logoUrl) : null;
  if (logo) {
    return `<img class="brand-logo" src="${esc(logo)}" alt="${esc(appName)}" referrerpolicy="no-referrer">`;
  }
  return `<svg class="mark" width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
  <circle cx="17" cy="17" r="15" stroke="var(--accent)" stroke-width="1.4" opacity=".4"/>
  <circle cx="17" cy="17" r="9.5" stroke="var(--accent)" stroke-width="1.4" opacity=".7"/>
  <circle cx="17" cy="17" r="3.6" fill="var(--accent)"/>
  <circle cx="32" cy="17" r="2.3" fill="var(--ink-4)"/>
</svg>`;
}

/** The Google button. An anchor, not a form control: it leaves the page. */
function googleButton(href, label = 'Continue with Google') {
  return `<a class="btn secondary google" href="${esc(href)}">
  <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/></svg>
  ${esc(label)}</a>`;
}

module.exports = { esc, scriptJson, safeColor, shell, errorPage, brandMark, googleButton, inkFor, icon, errorLine, passwordField, REVEAL_JS };
