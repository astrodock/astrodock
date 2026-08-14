# AGENTS.md

**This repository is the Astrodock platform itself — not an app that runs on it.**

If you are here to *build an app* on Astrodock, this is the wrong file. The contract lives at:

> **https://docs.astrodock.ai/AGENTS.md** — the platform contract: app layout, `app.json`,
> the injected environment, and the CLI loop.
>
> **https://docs.astrodock.ai/building-apps.md** — the long form, with examples and the
> full environment-variable catalog.

Both are real markdown files served from that host, so fetch them directly. The source lives
in [astrodock/astrodock-docs](https://github.com/astrodock/astrodock-docs).

This file used to be a byte-identical second copy of that contract. Two copies of a document
nobody is diffing is a document that is wrong in one place — so this is a pointer now, and the
docs repository is the only copy.

## If you are working on the platform

Read `CLAUDE.md` in this repository for project context and the decisions that are settled.
`BUILD_PLAN.md` is the ordered work plan. `docs/README.md` says where the documentation went.

The starter app under `examples/starter-app/` carries its own `AGENTS.md`, and that one *is*
app-facing — it describes the app it sits in, which is exactly what an app-level AGENTS.md
should do.
