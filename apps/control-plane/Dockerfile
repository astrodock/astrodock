# syntax=docker/dockerfile:1
# Toolstead control plane + runner (merged for v1; see DECISIONS.md B1).
# Multi-stage: build the admin SPA, then assemble the Node runtime that also has
# git + Docker CLI + PM2 so it can clone, build, and run apps.

# ── Stage 1: build the admin SPA ──
FROM node:22-bookworm-slim AS admin-build
WORKDIR /admin
COPY apps/admin/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/admin/ ./
RUN npm run build   # → /admin/dist

# ── Stage 2: runtime ──
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git rsync ca-certificates curl docker.io \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pm2

WORKDIR /app
# Install workspace runtime deps using the committed lockfile.
COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/auth-client/package.json packages/auth-client/package.json
COPY packages/cli/package.json packages/cli/package.json
# Runtime deps only; skip the admin workspace (built in stage 1) to keep the image lean.
RUN npm ci --omit=dev --workspace @toolstead/control-plane --include-workspace-root

# App source
COPY apps/control-plane apps/control-plane
COPY packages packages

# Built admin SPA → copied into the shared static volume at boot by the entrypoint
COPY --from=admin-build /admin/dist /opt/admin-dist
COPY apps/control-plane/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PM2_HOME=/data/pm2 \
    TOOLSTEAD_STATIC_DIR=/data/static \
    TOOLSTEAD_APPS_DIR=/data/apps \
    TOOLSTEAD_REPOS_DIR=/data/repos

WORKDIR /app/apps/control-plane
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
