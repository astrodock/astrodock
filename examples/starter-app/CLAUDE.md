# CLAUDE.md

This is a Toolstead app. The build + deploy contract lives in **`AGENTS.md`** (same dir) —
read it first. TL;DR: bind `TOOLSTEAD_PORT`, put server routes under `/api`, read config from
injected `TOOLSTEAD_*` env (never hardcode), add `GET /health`, deploy with the `toolstead` CLI.
