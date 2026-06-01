# Astrodock documentation site

This folder is the Astrodock docs — a small, hand-built static site (plain HTML/CSS/JS, no build
step or dependencies).

## View it

- **Locally:** open `docs/index.html` in a browser, or serve the folder with any static server:
  ```bash
  cd docs && python3 -m http.server 8080   # then open http://localhost:8080
  ```
- **Publish it:** it's static, so anything works — GitHub Pages (serve from `/docs`), Netlify, or
  even deploy it *as an Astrodock app* (a static-only, `auth: public` app).

## How it's put together

- `index.html` — landing page.
- One `.html` file per topic (e.g. `install.html`, `custom-domains.html`).
- `assets/styles.css` — all styling (light + dark theme).
- `assets/docs.js` — builds the shared chrome (top bar, sidebar, prev/next), code-copy buttons,
  theme toggle, and screenshot placeholders. **The navigation is defined once** in the `NAV` array
  at the top of this file.
- `assets/screenshots/` — drop real screenshots here (see its README).

## Add or edit a page

1. Copy an existing page (e.g. `install.html`) as a starting point.
2. Set `<body data-page="your-slug">`, the `<title>`, the `.eyebrow` (section), and `<h1>`.
3. Write your content inside `<article id="doc">…</article>` using the existing classes
   (`callout`, `steps`, `shot`, tables, `pre`/`code`).
4. Add the page to the `NAV` array in `assets/docs.js` so it shows in the sidebar.

That's it — no compile step. Reload the page.
