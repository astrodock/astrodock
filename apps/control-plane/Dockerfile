# syntax=docker/dockerfile:1
# Astrodock control plane + runner (merged for v1; see DECISIONS.md B1).
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
ARG TARGETARCH
# git + rsync for the buildpack; a CURRENT static Docker CLI (Debian's docker.io is
# too old for modern daemons) to drive sibling containers + the object store via the socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git rsync ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-amd64}" in arm64) DARCH=aarch64;; *) DARCH=x86_64;; esac \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.3.1.tgz" \
    | tar xz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker \
 && docker --version \
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
RUN npm ci --omit=dev --workspace @astrodock/control-plane --include-workspace-root

# App source
COPY apps/control-plane apps/control-plane
COPY packages packages

# Built admin SPA → copied into the shared static volume at boot by the entrypoint
COPY --from=admin-build /admin/dist /opt/admin-dist
COPY apps/control-plane/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Stamped by the release workflow from the git tag. NOT named ASTRODOCK_VERSION:
# that belongs to the host .env, where compose reads it to pick an image tag, and
# `env_file: .env` would then inject it here and make a box pinned to `latest`
# report its own version as "latest".
ARG ASTRODOCK_BUILD_VERSION=""
ARG ASTRODOCK_BUILD_COMMIT=""
ARG ASTRODOCK_BUILD_DATE=""

ENV ASTRODOCK_BUILD_VERSION=${ASTRODOCK_BUILD_VERSION} \
    ASTRODOCK_BUILD_COMMIT=${ASTRODOCK_BUILD_COMMIT} \
    ASTRODOCK_BUILD_DATE=${ASTRODOCK_BUILD_DATE} \
    NODE_ENV=production \
    PM2_HOME=/data/pm2 \
    ASTRODOCK_STATIC_DIR=/data/static \
    ASTRODOCK_APPS_DIR=/data/apps \
    ASTRODOCK_REPOS_DIR=/data/repos

WORKDIR /app/apps/control-plane
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
