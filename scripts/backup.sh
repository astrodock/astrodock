#!/usr/bin/env bash
#
# Astrodock local backup: pg_dump of the control-plane DB + every internal app DB,
# plus a snapshot of the bundled object store, into a timestamped tarball.
#
# Usage (from the repo root, with the stack running):
#   ./scripts/backup.sh [output-dir]
#
# Off-box durability (optional, off by default): set BACKUP_S3_BUCKET (+ AWS creds via
# the environment / awscli config) to also upload the tarball to an external S3 bucket.
# This is the one place an external dependency earns its keep — see docs/deploying.md.
set -euo pipefail

OUT_DIR="${1:-./backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
PG_USER="${ASTRODOCK_PG_USER:-astrodock}"

mkdir -p "$OUT_DIR"
echo "[backup] dumping all databases via the postgres container…"

# pg_dumpall captures the control-plane DB and every per-app internal DB + roles.
docker compose exec -T postgres pg_dumpall -U "$PG_USER" > "$WORK/all-databases.sql"

echo "[backup] snapshotting the object store volume…"
# Copy the objectstore data out of its container.
docker compose exec -T objectstore sh -c 'cd /data && tar cf - .' > "$WORK/objectdata.tar" 2>/dev/null || \
  echo "[backup] (object store snapshot skipped — container not running?)"

TARBALL="$OUT_DIR/astrodock-backup-$TS.tar.gz"
tar -czf "$TARBALL" -C "$WORK" .
rm -rf "$WORK"
echo "[backup] wrote $TARBALL"

# ── optional off-box upload (env-gated) ──
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup] uploading to s3://$BACKUP_S3_BUCKET/ …"
  aws s3 cp "$TARBALL" "s3://$BACKUP_S3_BUCKET/$(basename "$TARBALL")"
  echo "[backup] off-box upload complete"
fi

echo "[backup] done. Restore: gunzip the all-databases.sql and psql it back; untar objectdata into the volume."
