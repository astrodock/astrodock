/* Astrodock artifact client. Served at /_astrodock/client.js on every artifact host.
 *
 *   <script src="/_astrodock/client.js"></script>
 *   const me = await astrodock.me();              // { signedIn, email, role, roles, permissions }
 *   const tasks = astrodock.db('tasks');
 *   await tasks.list({ where: { done: false }, order: '-_createdAt', limit: 50 });
 *   await tasks.add({ title: 'Call the vendor' });
 *   await tasks.update(id, { done: true });       // pass _version to refuse a stale write
 *   await tasks.remove(id);
 *   await tasks.count('status');                  // { total, counts: { open: 3, done: 5 } }
 *   const stop = tasks.subscribe((change) => …);  // { type: 'create'|'update'|'delete', record }
 *   await tasks.attach(id, fileInput.files[0]);   // collections with "attachments"
 *   record._files                                 // [{ id, name, size, type, url }]
 *   await tasks.detach(id, fileId);
 *   const settings = astrodock.blob('settings');
 *   const { data, version } = await settings.get();
 *   await settings.set({ theme: 'dark' }, version);
 *
 * Errors are thrown as Error with .status (401, 403, 404, 409, 413…), and for a
 * rejected record .problems (a list of what was wrong). A 409 carries .current.
 *
 * The platform adds this script to every HTML page it serves. It reports the
 * page's own errors (uncaught errors, rejected promises, console.error, failed
 * requests) so the artifact's owner and agent can see them, and adds a small
 * "Report a Problem" link. A page that loads it again gets the same instance.
 */
(function () {
  'use strict';
  if (window.astrodock && window.astrodock.__loaded) return;
  var BASE = '/_astrodock/api';

  // ── error reporting ──
  var queue = [];
  var seen = {};
  var sent = 0;
  var MAX_PER_PAGE = 30;
  var timer = null;
  function report(kind, message, source, stack) {
    try {
      var msg = String(message == null ? '' : message).slice(0, 1000);
      var key = kind + '|' + msg + '|' + (source || '');
      if (seen[key] || sent >= MAX_PER_PAGE) return;
      seen[key] = true;
      sent++;
      queue.push({ kind: kind, message: msg, source: String(source || '').slice(0, 300), stack: String(stack || '').slice(0, 4000), path: location.pathname });
      if (!timer) timer = setTimeout(flush, 1500);
    } catch (e) { /* reporting must never throw */ }
  }
  function flush() {
    timer = null;
    if (!queue.length) return;
    var body = JSON.stringify({ reports: queue.splice(0, 10) });
    try {
      fetch(BASE + '/_log', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Astrodock': '1' }, body: body })
        .catch(function () { /* nothing to do */ });
    } catch (e) { /* nothing to do */ }
    if (queue.length) timer = setTimeout(flush, 1500);
  }
  window.addEventListener('error', function (ev) {
    if (ev && ev.target && ev.target !== window && (ev.target.src || ev.target.href)) {
      report('network', 'Failed to load ' + (ev.target.src || ev.target.href), ev.target.tagName, '');
      return;
    }
    var src = ev.filename ? ev.filename + ':' + ev.lineno + ':' + ev.colno : '';
    report('error', ev.message || 'Script error', src, ev.error && ev.error.stack);
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    report('rejection', r && r.message ? r.message : String(r), '', r && r.stack);
  });
  var origError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.message ? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a));
      }
      var first = arguments[0];
      report('console', parts.join(' '), '', first && first.stack);
    } catch (e) { /* ignore */ }
    return origError.apply(console, arguments);
  };
  window.addEventListener('pagehide', flush);

  // ── the Report a Problem link ──
  function footer() {
    if (document.getElementById('astrodock-report')) return;
    var a = document.createElement('a');
    a.id = 'astrodock-report';
    a.href = '/_astrodock/report';
    a.textContent = 'Report a Problem';
    a.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:2147483647;padding:2px 7px;'
      + 'font:11px/1.6 system-ui,sans-serif;color:#71717a;background:rgba(255,255,255,.85);text-decoration:none;'
      + 'box-shadow:0 0 0 1px rgba(0,0,0,.08)');
    document.body.appendChild(a);
  }
  if (document.body) footer();
  else document.addEventListener('DOMContentLoaded', footer);

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Astrodock': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts).catch(function (e) {
      report('network', method + ' ' + path + ' failed: ' + (e && e.message), '', '');
      throw e;
    }).then(function (res) {
      return res.text().then(function (txt) {
        var json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
        if (!res.ok) {
          var err = new Error((json && json.error) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          if (json && json.problems) err.problems = json.problems;
          if (json && json.current !== undefined) err.current = json.current;
          throw err;
        }
        return json;
      });
    });
  }

  function qs(opts) {
    var p = [];
    opts = opts || {};
    if (opts.where) p.push('where=' + encodeURIComponent(JSON.stringify(opts.where)));
    if (opts.order) p.push('order=' + encodeURIComponent(opts.order));
    if (opts.limit) p.push('limit=' + encodeURIComponent(opts.limit));
    if (opts.offset) p.push('offset=' + encodeURIComponent(opts.offset));
    if (opts.by) p.push('by=' + encodeURIComponent(opts.by));
    return p.length ? '?' + p.join('&') : '';
  }

  function collection(name) {
    var path = '/c/' + encodeURIComponent(name);
    return {
      list: function (opts) { return request('GET', path + qs(opts)).then(function (r) { return r.records; }); },
      get: function (id) { return request('GET', path + '/' + encodeURIComponent(id)).then(function (r) { return r.record; }); },
      add: function (data) { return request('POST', path, data).then(function (r) { return r.record; }); },
      update: function (id, patch) { return request('PATCH', path + '/' + encodeURIComponent(id), patch).then(function (r) { return r.record; }); },
      remove: function (id) { return request('DELETE', path + '/' + encodeURIComponent(id)); },
      count: function (by, where) { return request('GET', path + '/_count' + qs({ by: by, where: where })); },
      attach: function (id, file) {
        var form = new FormData();
        form.append('file', file, file.name || 'file');
        return fetch(BASE + path + '/' + encodeURIComponent(id) + '/files', { method: 'POST', credentials: 'same-origin', headers: { 'X-Astrodock': '1' }, body: form })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) {
              if (!res.ok) { var err = new Error(json.error || ('Upload failed (' + res.status + ')')); err.status = res.status; throw err; }
              return json.file;
            });
          });
      },
      detach: function (id, fileId) { return request('DELETE', path + '/' + encodeURIComponent(id) + '/files/' + encodeURIComponent(fileId)); },
      subscribe: function (fn) {
        var es = new EventSource(BASE + path + '/_stream');
        es.onmessage = function (ev) {
          try { fn(JSON.parse(ev.data)); } catch (e) { /* a malformed event is skipped */ }
        };
        return function () { es.close(); };
      }
    };
  }

  function blob(name) {
    var path = '/b/' + encodeURIComponent(name);
    return {
      get: function () { return request('GET', path); },
      set: function (data, version) { return request('PUT', path, { data: data, version: version }); }
    };
  }

  window.astrodock = {
    __loaded: true,
    report: function (message) { report('console', message, '', new Error(String(message)).stack); },
    me: function () { return request('GET', '/me'); },
    db: collection,
    blob: blob,
    signIn: function () { location.href = '/_astrodock/signin?next=' + encodeURIComponent(location.pathname + location.search); },
    signOut: function () {
      return fetch('/_astrodock/signout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Astrodock': '1' } })
        .then(function () { location.href = '/'; });
    }
  };
})();
