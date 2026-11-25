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
 *   const settings = astrodock.blob('settings');
 *   const { data, version } = await settings.get();
 *   await settings.set({ theme: 'dark' }, version);
 *
 * Errors are thrown as Error with .status (401, 403, 404, 409, 413…), and for a
 * rejected record .problems (a list of what was wrong). A 409 carries .current.
 */
(function () {
  'use strict';
  var BASE = '/_astrodock/api';

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Astrodock': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts).then(function (res) {
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
