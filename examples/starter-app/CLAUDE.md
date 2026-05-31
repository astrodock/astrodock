# CLAUDE.md

This is an Astrodock app. The build + deploy contract lives in **`AGENTS.md`** (same dir) —
read it first. TL;DR: bind `ASTRODOCK_PORT`, put server routes under `/api`, read config from
injected `ASTRODOCK_*` env (never hardcode), add `GET /health`, deploy with the `astrodock` CLI.
