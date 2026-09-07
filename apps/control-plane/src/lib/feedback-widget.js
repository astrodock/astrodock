'use strict';

// The drop-in feedback widget, served as one file from the platform.
//
// Shipped as a source string rather than a built asset on purpose: it has no
// dependencies, it must stay small enough to read, and an app should never be
// running a stale copy of it. One script tag, and the app is done:
//
//   <script src="https://auth.example.com/feedback/widget.js"
//           data-app="valise" defer></script>
//
// Identity is optional and is the app's own session token, which the platform
// can verify because it generated the signing secret. An app hands it over
// either as data-identity, or by setting window.AstrodockFeedback = { identity }
// before this loads, or by returning it from a function of the same name so a
// refreshed token is picked up.
//
// Everything is in a shadow root. A widget that inherits the host page's CSS
// looks broken on half the pages it is dropped into, and a widget that sets
// global styles breaks the other half.

function widgetSource() {
  return `(function () {
  'use strict';
  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) if (all[i].src.indexOf('/feedback/widget.js') > -1) return all[i];
    return null;
  })();
  if (!script) return;

  var slug = script.getAttribute('data-app');
  if (!slug) return console.warn('[feedback] data-app is required');
  var base = (script.getAttribute('data-host') || new URL(script.src).origin) + '/feedback/' + slug;
  var label = script.getAttribute('data-label') || 'Feedback';

  function identity() {
    var direct = script.getAttribute('data-identity');
    if (direct) return direct;
    var g = window.AstrodockFeedback;
    if (!g) return '';
    var v = typeof g === 'function' ? g() : (typeof g.identity === 'function' ? g.identity() : g.identity);
    return v || '';
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = identity();
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(base + (path || ''), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
      });
    });
  }

  var host = document.createElement('div');
  host.setAttribute('data-astrodock-feedback', '');
  var root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  root.innerHTML = [
    '<style>',
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, sans-serif; }',
    '.launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;',
    '  padding: 10px 16px; border-radius: 999px; border: 1px solid #d4d4d8; background: #fff;',
    '  color: #18181b; font-size: 14px; font-weight: 500; cursor: pointer;',
    '  box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.10); }',
    '.launch:hover { background: #fafafa; }',
    '.veil { position: fixed; inset: 0; z-index: 2147483001; background: rgba(9,9,11,.45);',
    '  display: flex; align-items: flex-end; justify-content: center; }',
    '@media (min-width: 640px) { .veil { align-items: center; } }',
    '.panel { background: #fff; width: 100%; max-width: 460px; border-radius: 14px 14px 0 0;',
    '  padding: 18px; max-height: 92vh; overflow: auto; }',
    '@media (min-width: 640px) { .panel { border-radius: 14px; } }',
    '.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }',
    '.head h2 { margin: 0; font-size: 16px; font-weight: 600; color: #18181b; }',
    '.x { border: 0; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #71717a; padding: 4px 6px; }',
    'label { display: block; font-size: 13px; font-weight: 500; color: #3f3f46; margin: 12px 0 5px; }',
    'select, textarea, input { width: 100%; padding: 9px 10px; font-size: 14px; color: #18181b;',
    '  border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; }',
    'textarea { min-height: 110px; resize: vertical; }',
    'select:focus, textarea:focus, input:focus { outline: 2px solid #4f46e5; outline-offset: -1px; border-color: #4f46e5; }',
    '.send { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 8px;',
    '  background: #4f46e5; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }',
    '.send:disabled { background: #a1a1aa; cursor: default; }',
    '.err { margin-top: 12px; font-size: 13px; color: #b91c1c; }',
    '.done { text-align: center; padding: 22px 8px; }',
    '.done h2 { margin: 0 0 8px; font-size: 17px; color: #18181b; }',
    '.done p { margin: 0; font-size: 14px; color: #52525b; line-height: 1.5; }',
    '.done code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }',
    '.hidden { display: none !important; }',
    '</style>',
    '<button class="launch" type="button">' + label + '</button>',
    '<div class="veil hidden"><div class="panel" role="dialog" aria-modal="true"></div></div>'
  ].join('');

  var launch = root.querySelector('.launch');
  var veil = root.querySelector('.veil');
  var panel = root.querySelector('.panel');
  var config = { categories: ['bug', 'idea', 'question'], anonymous: false, enabled: true, widget: true };

  var NAMES = { bug: 'Something is broken', idea: 'An idea', question: 'A question', other: 'Something else' };
  function nameFor(c) { return NAMES[c] || (c.charAt(0).toUpperCase() + c.slice(1)); }

  function form() {
    var needsEmail = config.anonymous && !identity();
    panel.innerHTML = [
      '<div class="head"><h2>' + label + '</h2><button class="x" type="button" aria-label="Close">&times;</button></div>',
      '<label for="fb-cat">What is this about?</label>',
      '<select id="fb-cat">' + config.categories.map(function (c) {
        return '<option value="' + c + '">' + nameFor(c) + '</option>';
      }).join('') + '</select>',
      '<label for="fb-body">Tell us what happened</label>',
      '<textarea id="fb-body" placeholder="What were you doing, and what did you expect?"></textarea>',
      needsEmail ? '<label for="fb-email">Your email, if you would like a reply</label><input id="fb-email" type="email" autocomplete="email">' : '',
      '<button class="send" type="button">Send</button>',
      '<div class="err hidden"></div>'
    ].join('');

    panel.querySelector('.x').addEventListener('click', close);
    var send = panel.querySelector('.send');
    send.addEventListener('click', function () {
      var text = panel.querySelector('#fb-body').value.trim();
      var err = panel.querySelector('.err');
      if (!text) { err.textContent = 'Tell us what happened first.'; err.classList.remove('hidden'); return; }
      send.disabled = true;
      send.textContent = 'Sending...';
      var emailField = panel.querySelector('#fb-email');
      api('', {
        method: 'POST',
        body: {
          body: text,
          category: panel.querySelector('#fb-cat').value,
          email: emailField ? emailField.value.trim() : '',
          context: {
            url: location.href,
            path: location.pathname,
            referrer: document.referrer,
            viewport: window.innerWidth + 'x' + window.innerHeight,
            locale: navigator.language
          }
        }
      }).then(function (res) {
        panel.innerHTML = [
          '<div class="done">',
          '<h2>Thank you</h2>',
          '<p>We have this as <code>' + res.key + '</code>. If we need anything else, we will be in touch.</p>',
          '</div>'
        ].join('');
        setTimeout(close, 2600);
      }).catch(function (e) {
        send.disabled = false;
        send.textContent = 'Send';
        err.textContent = e.message;
        err.classList.remove('hidden');
      });
    });
  }

  function open() {
    veil.classList.remove('hidden');
    form();
    var box = panel.querySelector('#fb-body');
    if (box) box.focus();
  }
  function close() { veil.classList.add('hidden'); }

  launch.addEventListener('click', open);
  veil.addEventListener('click', function (e) { if (e.target === veil) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !veil.classList.contains('hidden')) close();
  });

  // Ask the platform how this app is configured. A failure here leaves the
  // defaults in place rather than hiding the button: not knowing the category
  // list is not a reason to stop someone reporting a bug.
  api('/config').then(function (c) {
    config = c;
    if (!c.enabled || !c.widget) host.remove();
  }).catch(function () {});
})();
`;
}

module.exports = { widgetSource };
