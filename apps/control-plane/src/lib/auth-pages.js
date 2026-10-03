'use strict';

// The pages an app's end users see on the platform's own origin: the hosted
// sign-in, and the invite they redeem before they have one.
//
// Shared rather than copied, because the two are the same surface at two
// moments. When these lived inside the sign-in route, the invite page had the
// choice of importing a route file for its CSS or growing a second stylesheet
// that would drift from the first by the next change to either.
//
// Self-contained by design: no webfont, no stylesheet request, no bundle. This
// renders before anything else an app owns has loaded, and a page with no
// dependencies is a page with a small attack surface.

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

function shell(title, body, { accent = null } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
/* This page is the only Astrodock surface an app's end users ever see, and it
   used to be a generic blue form — GitHub-ish greys and #2f6df6 — sharing no
   colour, radius or type with the dashboard. Same tokens as the admin theme
   now, both schemes. Kept self-contained: no webfont, no stylesheet request,
   because it renders on an app's own domain before anything else loads. */
:root{
  color-scheme:light dark;
  --bg:#f4f6fa; --surface:#fff; --line:#dce2ec; --field:#f4f7fb;
  --text:#121823; --text-2:#445064; --text-3:#626e7d;
  --accent:${accent || '#0b7c56'}; --accent-ink:#fff;
  --danger:#d12536; --danger-bg:rgba(209,37,54,.10);
  --r:14px; --r-sm:9px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0a0e15; --surface:#0f141d; --line:#222d3b; --field:#0c121b;
  --text:#f1f5fa; --text-2:#b6c4d4; --text-3:#8595a8;
  --accent:${accent || '#2fe6a8'}; --accent-ink:#06120d;
  --danger:#ff6573; --danger-bg:rgba(255,101,115,.13);
}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);
  display:grid;place-items:center;min-height:100vh;margin:0;line-height:1.55;letter-spacing:.1px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:2.1rem;
  width:min(92vw,24rem);box-shadow:0 14px 40px rgba(20,30,60,.09)}
.mark{display:block;margin:0 auto .9rem}
.brand-logo{display:block;margin:0 auto 1rem;max-height:48px;max-width:180px;object-fit:contain}
h1{font-size:1.2rem;font-weight:650;letter-spacing:-.3px;margin:0 0 .3rem;text-align:center}
/* A heading with no subtitle under it carries the subtitle's spacing. */
h1.solo{margin-bottom:1.5rem}
p.sub{margin:0 0 1.5rem;color:var(--text-3);font-size:.88rem;text-align:center}
label{display:block;font-size:.79rem;font-weight:600;color:var(--text-2);margin:0 0 .35rem}
input{width:100%;padding:.62rem .72rem;border:1px solid var(--line);border-radius:var(--r-sm);
  font-size:1rem;font-family:inherit;margin-bottom:.9rem;background:var(--field);color:inherit;
  outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
button{width:100%;padding:.72rem;border:0;border-radius:var(--r-sm);background:var(--accent);
  color:var(--accent-ink);font-family:inherit;font-weight:650;font-size:.95rem;cursor:pointer;
  transition:filter .15s}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.6;cursor:default}
button.secondary,a.secondary{background:transparent;border:1px solid var(--line);color:var(--text-2);margin-top:.6rem}
button.secondary:hover,a.secondary:hover{border-color:var(--accent);color:var(--accent);filter:none}
/* The Google button is an anchor, not a form control: it leaves the page. */
a.secondary{display:flex;align-items:center;justify-content:center;gap:.5rem;
  width:100%;padding:.7rem 1rem;border-radius:8px;text-decoration:none;font:inherit;box-sizing:border-box}
a.secondary svg{flex:none}
.err{background:var(--danger-bg);color:var(--danger);padding:.62rem .72rem;border-radius:var(--r-sm);
  font-size:.86rem;margin-bottom:.9rem;display:none}
.muted{text-align:center;color:var(--text-3);font-size:.76rem;margin-top:1.2rem}
/* Which address is being set up. Stated rather than assumed: an invite may have
   gone to a work address when someone expected their personal one. */
.who{text-align:center;color:var(--text-2);font-size:.84rem;margin:0 0 1rem}
.who strong{font-weight:600;color:var(--text)}
/* A divider that says what the second option is, rather than a bare "or". */
.or{display:flex;align-items:center;gap:.7rem;margin:1.3rem 0 1rem;
  color:var(--text-3);font-size:.76rem}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function errorPage(title, message) {
  return shell(title, `<h1>${esc(title)}</h1><p class="sub">${esc(message)}</p>`);
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
  <circle cx="32" cy="17" r="2.3" fill="var(--text-3)"/>
</svg>`;
}

/** The Google button. An anchor, not a form control: it leaves the page. */
function googleButton(href, label = 'Continue with Google') {
  return `<a class="secondary google" href="${esc(href)}">
  <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/></svg>
  ${esc(label)}</a>`;
}

module.exports = { esc, scriptJson, safeColor, shell, errorPage, brandMark, googleButton };
