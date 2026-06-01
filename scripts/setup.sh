#!/bin/sh
# Astrodock setup — generates a ready-to-use .env (auto-filling all secrets) so you
# never hand-edit config or paste random strings. Dependency-free POSIX shell.
#
#   ./scripts/setup.sh                         # interactive (asks domain/email/password)
#   ./scripts/setup.sh --domain apps.example.com --email you@example.com
#   ./scripts/setup.sh --local                 # local testing (localhost, plain HTTP)
#   ./scripts/setup.sh --domain x --email y --up   # ...and then `docker compose up -d`
#
# Flags: --domain D  --email E  --admin-email E  --admin-password P  --tls auto|internal|off
#        --local  --up  --force (overwrite an existing .env)  -y/--yes (no prompts)  -h/--help
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE="$REPO/.env.example"
OUT="$REPO/.env"

DOMAIN=""; EMAIL=""; ADMIN_EMAIL=""; ADMIN_PASSWORD=""; TLS=""; LOCAL=0; FORCE=0; UP=0; YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --tls) TLS="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --up) UP=1; shift ;;
    --force) FORCE=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found — run this from inside the Astrodock repo." >&2; exit 1; }

# random secret: prefer openssl, fall back to /dev/urandom
rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n'; fi
}
prompt() { # prompt VAR "question" "default"
  _q="$2"; _def="${3:-}"
  if [ "$YES" = 1 ]; then printf '%s' "$_def"; return; fi
  if [ -n "$_def" ]; then printf '%s [%s]: ' "$_q" "$_def" >&2; else printf '%s: ' "$_q" >&2; fi
  IFS= read -r _ans < /dev/tty || _ans=""
  [ -n "$_ans" ] && printf '%s' "$_ans" || printf '%s' "$_def"
}

if [ -f "$OUT" ] && [ "$FORCE" != 1 ]; then
  echo "An .env already exists at $OUT." >&2
  echo "Re-run with --force to regenerate it. WARNING: that creates new secrets — it will" >&2
  echo "invalidate existing logins and make already-encrypted data unreadable. Don't --force a" >&2
  echo "live install unless you know what you're doing." >&2
  exit 1
fi

# ── decide mode ──
if [ "$LOCAL" != 1 ] && [ -z "$DOMAIN" ] && [ "$YES" != 1 ] && [ -e /dev/tty ]; then
  echo "Where will this run?"
  echo "  1) A public server  (you have a domain; real HTTPS)"
  echo "  2) Locally          (this machine only; for testing)"
  case "$(prompt _ 'Choose 1 or 2' '1')" in 2) LOCAL=1 ;; *) LOCAL=0 ;; esac
fi

if [ "$LOCAL" = 1 ]; then
  DOMAIN="localhost"; TLS="${TLS:-off}"
else
  [ -n "$DOMAIN" ] || DOMAIN=$(prompt _ "Base domain (apps live at <name>.<domain>, e.g. apps.example.com)")
  [ -n "$DOMAIN" ] || { echo "error: a base domain is required for a server install (or use --local)." >&2; exit 1; }
  TLS="${TLS:-auto}"
  [ -n "$EMAIL" ] || EMAIL=$(prompt _ "Email for HTTPS certificates")
fi

[ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL="${EMAIL:-admin@$DOMAIN}"
GENERATED_PW=0
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ "$YES" = 1 ] || [ ! -e /dev/tty ]; then ADMIN_PASSWORD=$(rand | cut -c1-24); GENERATED_PW=1
  else
    ADMIN_PASSWORD=$(prompt _ "Admin dashboard password (blank = auto-generate)")
    [ -n "$ADMIN_PASSWORD" ] || { ADMIN_PASSWORD=$(rand | cut -c1-24); GENERATED_PW=1; }
  fi
fi

# ── generate secrets ──
JWT=$(rand); SECRET=$(rand); RUNNER=$(rand); PGPW=$(rand); OBJ=$(rand)

# ── write .env from the template, overriding the managed keys, keeping comments ──
tmp=$(mktemp)
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ASTRODOCK_BASE_DOMAIN=*)            printf 'ASTRODOCK_BASE_DOMAIN=%s\n' "$DOMAIN" ;;
    ASTRODOCK_TLS_MODE=*)               printf 'ASTRODOCK_TLS_MODE=%s\n' "$TLS" ;;
    ASTRODOCK_ACME_EMAIL=*)             printf 'ASTRODOCK_ACME_EMAIL=%s\n' "${EMAIL:-}" ;;
    ASTRODOCK_ADMIN_EMAIL=*)            printf 'ASTRODOCK_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL" ;;
    ASTRODOCK_ADMIN_PASSWORD=*)         printf 'ASTRODOCK_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" ;;
    ASTRODOCK_ADMIN_JWT_SECRET=*)       printf 'ASTRODOCK_ADMIN_JWT_SECRET=%s\n' "$JWT" ;;
    ASTRODOCK_SECRET_KEY=*)             printf 'ASTRODOCK_SECRET_KEY=%s\n' "$SECRET" ;;
    ASTRODOCK_RUNNER_TOKEN=*)           printf 'ASTRODOCK_RUNNER_TOKEN=%s\n' "$RUNNER" ;;
    ASTRODOCK_PG_PASSWORD=*)            printf 'ASTRODOCK_PG_PASSWORD=%s\n' "$PGPW" ;;
    ASTRODOCK_OBJECTSTORE_SECRET_KEY=*) printf 'ASTRODOCK_OBJECTSTORE_SECRET_KEY=%s\n' "$OBJ" ;;
    *)                                  printf '%s\n' "$line" ;;
  esac
done < "$TEMPLATE" > "$tmp"
mv "$tmp" "$OUT"
chmod 600 "$OUT"

# ── summary ──
ADMIN_URL=$([ "$LOCAL" = 1 ] && echo "http://admin.$DOMAIN" || echo "https://admin.$DOMAIN")
echo ""
echo "✓ Wrote $OUT (secrets generated; permissions set to 600)."
echo ""
echo "  Dashboard:  $ADMIN_URL"
echo "  Admin login: $ADMIN_EMAIL"
[ "$GENERATED_PW" = 1 ] && echo "  Admin password (save this!): $ADMIN_PASSWORD"
echo ""
if [ "$UP" = 1 ]; then
  echo "Starting the stack…"
  ( cd "$REPO" && docker compose up -d )
  echo ""
  echo "Done. Open $ADMIN_URL once the services are healthy (docker compose ps)."
else
  echo "Next:  docker compose up -d      # then open $ADMIN_URL"
fi
[ "$LOCAL" != 1 ] && echo "Reminder: point a wildcard DNS record  *.$DOMAIN  at this server, and allow ports 80/443."
exit 0
