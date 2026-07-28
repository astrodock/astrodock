#!/bin/sh
# Runs the backup/restore test against a disposable Postgres, then removes it.
#
# The test refuses to run unless its client connection and its `docker exec` land
# on the same cluster, so both have to be pointed at the container this creates.
set -e
NAME=adock-restore-test
PORT=${RESTORE_TEST_PORT:-55444}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$NAME" \
  -e POSTGRES_USER=astrodock -e POSTGRES_PASSWORD=astrodock -e POSTGRES_DB=astrodock \
  -p "$PORT":5432 postgres:16-alpine >/dev/null

i=0
while [ $i -lt 30 ]; do
  docker exec "$NAME" pg_isready -U astrodock >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done

ASTRODOCK_PG_CONTAINER="$NAME" \
ASTRODOCK_PG_HOST=127.0.0.1 ASTRODOCK_PG_PORT="$PORT" \
ASTRODOCK_PG_USER=astrodock ASTRODOCK_PG_PASSWORD=astrodock ASTRODOCK_PG_DATABASE=astrodock \
  node "$(dirname "$0")/backup-restore.test.mjs"
