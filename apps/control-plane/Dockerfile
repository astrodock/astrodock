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
#
# tini is the process reaper. Node runs as PID 1 in these containers, and PID 1
# inherits every orphaned process on the box: the runner shells out constantly
# (git, rsync, docker, pm2), and when one of those outlives its immediate parent
# it reparents to PID 1. Node does not reap processes it did not spawn, so they
# sat as zombies until the container was restarted — 47 of them after five weeks
# on the first install to run long enough to notice. tini reaps them.
#
# Deliberately here and not `init: true` in docker-compose.yml: the compose file
# lives on the operator's disk and is never refreshed by a pull, so a fix that
# needs a compose edit reaches new installs only. This one ships in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git rsync ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-amd64}" in arm64) DARCH=aarch64;; *) DARCH=x86_64;; esac \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.3.1.tgz" \
    | tar xz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker \
 && docker --version \
 # The compose plugin, so the platform can update itself: the updater runs as a
 # one-shot container from THIS image, which is already on the box, rather than
 # pulling a compose-capable image at the exact moment the operator is asking for
 # an update. One less thing that has to work when you most need it to.
 && case "${TARGETARCH:-amd64}" in arm64) CARCH=aarch64;; *) CARCH=x86_64;; esac \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-${CARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version \
 # ENTRYPOINT hard-codes this path, and a wrong one would fail every container at
 # boot rather than here.
 && /usr/bin/tini --version \
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
# tini as PID 1, so orphaned children get reaped instead of accumulating. It
# forwards signals to the entrypoint, so `docker compose down` still stops the
# process the same way it did before.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
