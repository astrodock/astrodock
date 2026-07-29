#!/bin/sh
# Runs the Pages object-store test against a throwaway SeaweedFS, then removes it.
# The test is a no-op without ASTRODOCK_OBJECTSTORE_ENDPOINT, so the main suite
# skips it and this script is how you actually exercise the S3 paths.
set -e
NAME=adock-seaweed-test
PORT=${PAGES_STORE_TEST_PORT:-58333}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$NAME" -p "$PORT":8333 chrislusf/seaweedfs:3.80 \
  server -dir=/data -s3 -s3.port=8333 -ip.bind=0.0.0.0 -volume.max=0 -master.volumeSizeLimitMB=64 >/dev/null

i=0
while [ $i -lt 60 ]; do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT" 2>/dev/null && break
  i=$((i + 1)); sleep 1
done

export ASTRODOCK_OBJECTSTORE_ENDPOINT="http://127.0.0.1:$PORT"
export ASTRODOCK_OBJECTSTORE_ACCESS_KEY=test
export ASTRODOCK_OBJECTSTORE_SECRET_KEY=test
export ASTRODOCK_OBJECTSTORE_BUCKET=astrodock-test

node "$(dirname "$0")/pages-store.test.mjs"
# The route-level suite takes its happy path only when a store is reachable —
# notably the reissue-address flow, which moves real objects.
node "$(dirname "$0")/pages.test.mjs"
