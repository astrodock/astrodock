#!/bin/sh
set -e

if [ "$TOOLSTEAD_ROLE" = "runner" ]; then
  # Runner container: owns the Docker socket, PAT, PM2, and the build volumes.
  mkdir -p "${TOOLSTEAD_APPS_DIR:-/data/apps}" "${TOOLSTEAD_REPOS_DIR:-/data/repos}" "${TOOLSTEAD_STATIC_DIR:-/data/static}" "${PM2_HOME:-/data/pm2}"
  # #5: bring back Node buildpack apps saved before the last restart.
  pm2 resurrect >/dev/null 2>&1 || pm2 ping >/dev/null 2>&1 || true
  exec node src/runner/server.js
fi

# Control-plane container: publish the admin SPA into the shared static volume.
ADMIN_DST="${TOOLSTEAD_STATIC_DIR:-/data/static}/__admin"
mkdir -p "$ADMIN_DST"
if [ -d /opt/admin-dist ]; then
  rsync -a --delete /opt/admin-dist/ "$ADMIN_DST/"
fi

exec node server.js
