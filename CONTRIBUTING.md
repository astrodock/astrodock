# Contributing to Toolstead

Thanks for your interest. Toolstead is an early-stage rebuild — see `OPEN_SOURCE.md` for the
roadmap and `DECISIONS.md` for decisions already made (and why).

## Dev setup
Requirements: Node ≥ 20, Docker, and (for running the control plane outside Docker) Postgres 16.

```bash
git clone <your-fork>
cd toolstead
npm install                      # installs all workspaces
```

### Run the whole stack (closest to production)
```bash
cp .env.example .env             # fill in secrets
docker compose up -d
docker compose logs -f api
```

### Run the control plane against a local Postgres (fast iteration)
```bash
# point apps/control-plane/.env at a local Postgres (see apps/control-plane/.env.example)
npm run migrate -w @toolstead/control-plane
npm run seed    -w @toolstead/control-plane
npm run dev:api                  # control plane with --watch
npm run dev:admin                # admin UI (Vite dev server, proxies /admin → :3100)
```

## Tests
```bash
npm test -w @toolstead/schema          # schema validator + env catalog (no DB)
npm test -w @toolstead/control-plane   # unit + integration (needs a live Postgres)
npm test -w @toolstead/cli             # CLI against an in-process control plane (needs Postgres)
```
The control-plane and CLI tests read `apps/control-plane/.env` for the Postgres connection.

## Project layout & conventions
- Workspaces: `apps/*`, `packages/*`. The control plane and CLI are CommonJS; the admin and the
  starter frontend are ESM (Vite).
- Platform-managed config uses the reserved `TOOLSTEAD_` env prefix. App-declared vars may not.
- Data layer is Drizzle + plain SQL migrations under `apps/control-plane/src/db/migrations`
  (applied by `src/db/migrate.js`). Keep `schema.js` and the SQL in sync.
- Match the style of the surrounding code. Keep functions small and readable.

## Pull requests
- Keep PRs focused. Include tests for new control-plane behavior where practical.
- Don't commit secrets (`.env*`, `setup.conf` are gitignored — only `*.example` is committed).
- Note any change to the `app.json` schema or the `TOOLSTEAD_*` env contract in `docs/building-apps.md`
  and `AGENTS.md`.

## Security
See `SECURITY.md`. Please report vulnerabilities privately, not in public issues.
