# Build notes — running log

A chronological log of the unattended build, and (most importantly) the **verified vs.
unverified** status of each piece. See `DECISIONS.md` for the choices made along the way.

## Verification legend
- ✅ **verified** — exercised in this build environment (Node + local Postgres) and passing.
- 📦 **unverified-in-sandbox** — implemented to spec and read-reviewed, but needs a real Docker
  host to exercise end-to-end (Caddy routing, SeaweedFS, the Docker-app runner path).

## Environment available during the build
Node 24, npm 11, Docker 29 (CLI present; full compose stack not booted here), git 2.50,
Postgres 16 (local, via Homebrew — used as the live test DB).

---

## Log

### Stage 0 — repo init ✅
- `git init`, branch `main`, baseline commit `chore: initial fork…`. Secret scan clean.
- Git operations run with the sandbox disabled (the sandbox denies writes to `.git`).

### Stage 1 — monorepo skeleton + foundations ✅
- Workspace root `package.json` (npm workspaces: `apps/*`, `packages/*`).
- `git mv auth-api → apps/control-plane`, `auth-admin → apps/admin`; legacy docs → `docs/legacy/`.
- `@toolstead/auth-client` — rebranded, config-from-env defaults, `.d.ts` added. ✅
- `@toolstead/schema` — `app.json` JSON Schema (Draft 2020-12) + validator + reserved-env
  catalog + required-var helper. **11/11 unit tests pass.** ✅
- `@toolstead/cli`, `@toolstead/control-plane` package manifests written (deps installed).
- Deep de-brand of the control-plane source and admin UI happens inside their rewrite stages
  (3 and 7) since those files are being rewritten anyway. Final tree is grep-clean of
  `seniorverse` / `@sv` / "SV Platform".

(further stages appended below as they complete)
