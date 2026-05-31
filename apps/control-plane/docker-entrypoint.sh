#!/bin/sh
set -e

# Publish the built admin SPA into the shared static volume so Caddy can serve it
# at admin.<base-domain>.
ADMIN_DST="${TOOLSTEAD_STATIC_DIR:-/data/static}/__admin"
mkdir -p "$ADMIN_DST"
if [ -d /opt/admin-dist ]; then
  rsync -a --delete /opt/admin-dist/ "$ADMIN_DST/"
fi

mkdir -p "${TOOLSTEAD_APPS_DIR:-/data/apps}" "${TOOLSTEAD_REPOS_DIR:-/data/repos}"

# Start PM2 daemon (manages node buildpack apps) then the control plane in the foreground.
pm2 ping >/dev/null 2>&1 || true

exec node server.js
