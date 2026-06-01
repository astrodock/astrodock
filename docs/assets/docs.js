/* Astrodock docs — builds the page chrome from a single nav definition.
   A page only needs:  <body data-page="SLUG">  +  <article id="doc"> … </article>
   (the home page omits #doc and just gets the top bar + theme toggle). */
(function () {
  'use strict';

  // Update this when you publish the repo:
  var GITHUB_URL = 'https://github.com/your-org/astrodock';

  var NAV = [
    { title: 'Get started', items: [
      { slug: 'introduction', file: 'introduction.html', title: 'Introduction' },
      { slug: 'install',      file: 'install.html',      title: 'Install & run' },
      { slug: 'first-app',    file: 'first-app.html',    title: 'Deploy your first app' }
    ] },
    { title: 'Install on a server', items: [
      { slug: 'install-digitalocean', file: 'install-digitalocean.html', title: 'DigitalOcean droplet' },
      { slug: 'install-vps',          file: 'install-vps.html',          title: 'Your own server / any VPS' },
      { slug: 'install-local',        file: 'install-local.html',        title: 'Run locally (to test)' }
    ] },
    { title: 'Guides', items: [
      { slug: 'custom-domains',   file: 'custom-domains.html',     title: 'Custom domains & DNS' },
      { slug: 'email',            file: 'email-notifications.html', title: 'Email notifications' },
      { slug: 'external-database', file: 'external-database.html',  title: 'External database' },
      { slug: 'external-storage',  file: 'external-storage.html',   title: 'External object storage' },
      { slug: 'users',            file: 'users.html',              title: 'Manage users & access' },
      { slug: 'secrets',          file: 'secrets.html',            title: 'Secrets & env vars' },
      { slug: 'api-tokens',       file: 'api-tokens.html',         title: 'API tokens' },
      { slug: 'backups',          file: 'backups.html',            title: 'Backups & restore' },
      { slug: 'upgrading',        file: 'upgrading.html',          title: 'Upgrading' }
    ] },
    { title: 'Building apps', items: [
      { slug: 'building-apps',    file: 'building-apps.html',    title: 'App structure & app.json' },
      { slug: 'deploy-lifecycle', file: 'deploy-lifecycle.html', title: 'The deploy lifecycle' },
      { slug: 'dockerfile-apps',  file: 'dockerfile-apps.html',  title: 'Dockerfile apps' },
      { slug: 'ai-agents',        file: 'ai-agents.html',        title: 'Let an AI build & deploy' }
    ] },
    { title: 'Reference', items: [
      { slug: 'configuration',  file: 'configuration.html',  title: 'Configuration (.env)' },
      { slug: 'cli',            file: 'cli.html',            title: 'CLI commands' },
      { slug: 'admin-ui',       file: 'admin-ui.html',       title: 'Admin UI' },
      { slug: 'env-vars',       file: 'env-vars.html',       title: 'app.json & env reference' },
      { slug: 'architecture',   file: 'architecture.html',   title: 'Architecture' },
      { slug: 'security',       file: 'security.html',       title: 'Security' },
      { slug: 'troubleshooting', file: 'troubleshooting.html', title: 'Troubleshooting' }
    ] }
  ];

  function flat() {
    var out = [];
    NAV.forEach(function (g) { g.items.forEach(function (i) { out.push(i); }); });
    return out;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ── top bar (every page) ──
  function buildTopbar() {
    var bar = el('header', 'topbar');
    bar.innerHTML =
      '<button class="tbtn menu-toggle" aria-label="Menu">☰</button>' +
      '<a class="brand" href="index.html"><span class="mark">AD</span>Astrodock <small>docs</small></a>' +
      '<span class="spacer"></span>' +
      '<button class="tbtn theme-toggle" aria-label="Toggle theme" title="Toggle light/dark">◐</button>' +
      '<a class="tbtn" href="' + GITHUB_URL + '">GitHub ↗</a>';
    document.body.insertBefore(bar, document.body.firstChild);
    bar.querySelector('.theme-toggle').addEventListener('click', toggleTheme);
    var mt = bar.querySelector('.menu-toggle');
    if (mt) mt.addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  }

  // ── sidebar ──
  function buildSidebar(active) {
    var html = '';
    NAV.forEach(function (g) {
      html += '<h4>' + g.title + '</h4>';
      g.items.forEach(function (i) {
        html += '<a class="' + (i.slug === active ? 'active' : '') + '" href="' + i.file + '">' + i.title + '</a>';
      });
    });
    var aside = el('aside', 'sidebar', html);
    aside.id = 'sidebar';
    aside.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') document.body.classList.remove('nav-open');
    });
    return aside;
  }

  // ── prev / next pager ──
  function buildPager(active) {
    var list = flat(), idx = -1;
    for (var k = 0; k < list.length; k++) if (list[k].slug === active) idx = k;
    var nav = el('nav', 'pager');
    if (idx > 0) {
      var p = list[idx - 1];
      nav.innerHTML += '<a class="prev" href="' + p.file + '"><span class="dir">← Previous</span><br><span class="ttl">' + p.title + '</span></a>';
    }
    if (idx >= 0 && idx < list.length - 1) {
      var n = list[idx + 1];
      nav.innerHTML += '<a class="next" href="' + n.file + '"><span class="dir">Next →</span><br><span class="ttl">' + n.title + '</span></a>';
    }
    return nav;
  }

  function slugify(s) {
    return s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function addAnchors(doc) {
    doc.querySelectorAll('h2, h3').forEach(function (h) {
      if (!h.id) h.id = slugify(h.textContent);
      var a = el('a', 'anchor', '#');
      a.href = '#' + h.id;
      h.appendChild(a);
    });
  }
  function addCopyButtons(doc) {
    doc.querySelectorAll('pre').forEach(function (pre) {
      var b = el('button', 'copy', 'Copy');
      b.addEventListener('click', function () {
        var code = pre.querySelector('code') || pre;
        navigator.clipboard.writeText(code.innerText.replace(/\n$/, '')).then(function () {
          b.textContent = 'Copied'; b.classList.add('done');
          setTimeout(function () { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
        });
      });
      pre.appendChild(b);
    });
  }
  // <figure class="shot" data-file="apps.png" data-caption="The Apps page"></figure>
  // Shows a placeholder box; if assets/screenshots/<file> exists it swaps in the real
  // image automatically — so adding screenshots later is zero effort.
  function renderPlaceholders(root) {
    root.querySelectorAll('figure.shot').forEach(function (fig) {
      var file = fig.getAttribute('data-file') || 'screenshot.png';
      var cap = fig.getAttribute('data-caption') || '';
      var path = 'assets/screenshots/' + file;
      var capHtml = cap ? '<figcaption>' + cap + '</figcaption>' : '';
      fig.innerHTML =
        '<div class="ph"><div><div class="ic">📷</div><div class="lbl">Screenshot placeholder</div>' +
        '<div class="file">' + path + '</div></div></div>' + capHtml;
      var probe = new Image();
      probe.onload = function () {
        fig.innerHTML = '<img alt="' + (cap || 'screenshot').replace(/"/g, '') + '" src="' + path + '">' + capHtml;
      };
      probe.src = path;
    });
  }

  // ── theme ──
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
  function toggleTheme() {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('astro-theme', t); } catch (e) {}
    applyTheme(t);
  }
  (function initTheme() {
    var saved;
    try { saved = localStorage.getItem('astro-theme'); } catch (e) {}
    if (saved) applyTheme(saved);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
  })();

  document.addEventListener('DOMContentLoaded', function () {
    buildTopbar();
    var doc = document.getElementById('doc');
    if (!doc) return; // home / landing page: top bar only
    var active = document.body.getAttribute('data-page') || '';
    var layout = el('div', 'layout');
    var main = el('main', 'content'); main.id = 'content';
    doc.parentNode.removeChild(doc);
    main.appendChild(doc);
    main.appendChild(buildPager(active));
    layout.appendChild(buildSidebar(active));
    layout.appendChild(main);
    document.body.appendChild(layout);
    addAnchors(doc);
    addCopyButtons(doc);
    renderPlaceholders(doc);
  });
})();
