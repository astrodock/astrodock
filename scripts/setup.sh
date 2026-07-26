#!/bin/sh
# Astrodock setup — writes a .env with every secret generated for you. Dependency-free POSIX shell.
#
# By default this asks NOTHING. It only creates the secrets the stack cannot invent
# for itself, and leaves the domain and the administrator account blank on purpose:
# the platform boots into first-run setup and you finish in the browser, where it
# can show you the DNS record to create and check it for you. So the whole install is:
#
#   ./scripts/setup.sh && docker compose up -d      # then open http://<your-server-ip>
#
# If you would rather configure from the shell, the flags below skip the matching
# step of the wizard:
#
#   ./scripts/setup.sh --domain apps.example.com --email you@example.com   # skip the domain step
#   ./scripts/setup.sh --admin-email you@example.com --admin-password '…'  # skip the account step
#   ./scripts/setup.sh --local                     # localhost, plain HTTP (testing)
#   ./scripts/setup.sh --up                        # ...and then `docker compose up -d`
#
# Flags: --domain D  --email E  --admin-email E  --admin-password P  --tls auto|internal|off
#        --setup-token T (choose the first-run token instead of reading it from the logs)
#        --local  --up  --force (overwrite an existing .env)  -h/--help
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE="$REPO/.env.example"
OUT="$REPO/.env"

DOMAIN=""; EMAIL=""; ADMIN_EMAIL=""; ADMIN_PASSWORD=""; TLS=""; LOCAL=0; FORCE=0; UP=0
SETUP_TOKEN="${ASTRODOCK_SETUP_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --setup-token) SETUP_TOKEN="$2"; shift 2 ;;
    --tls) TLS="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --up) UP=1; shift ;;
    --force) FORCE=1; shift ;;
    -y|--yes) shift ;;   # accepted for compatibility; there are no prompts to skip
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found — run this from inside the Astrodock repo." >&2; exit 1; }

# random secret: prefer openssl, fall back to /dev/urandom
rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n'; fi
}

if [ -f "$OUT" ] && [ "$FORCE" != 1 ]; then
  echo "An .env already exists at $OUT." >&2
  echo "Re-run with --force to regenerate it. WARNING: that creates new secrets — it will" >&2
  echo "invalidate existing logins and make already-encrypted data unreadable. Don't --force a" >&2
  echo "live install unless you know what you're doing." >&2
  exit 1
fi

# ── mode ──
# --local is the one case where we pick a domain for you, because "localhost" is
# not something a wizard could verify by DNS anyway.
if [ "$LOCAL" = 1 ]; then
  DOMAIN="${DOMAIN:-localhost}"
  TLS="${TLS:-off}"
else
  TLS="${TLS:-auto}"
fi

# ── generate secrets ──
JWT=$(rand); SECRET=$(rand); RUNNER=$(rand); PGPW=$(rand); OBJ=$(rand)

# ── write .env from the template, overriding the managed keys, keeping comments ──
# Staged beside the target rather than in TMPDIR: same filesystem means the mv is a
# real atomic rename (a half-written .env with secrets in it would be nasty), and it
# sidesteps mktemp's platform differences.
tmp="$OUT.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM
: > "$tmp"
chmod 600 "$tmp"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ASTRODOCK_BASE_DOMAIN=*)            printf 'ASTRODOCK_BASE_DOMAIN=%s\n' "$DOMAIN" ;;
    ASTRODOCK_TLS_MODE=*)               printf 'ASTRODOCK_TLS_MODE=%s\n' "$TLS" ;;
    ASTRODOCK_ACME_EMAIL=*)             printf 'ASTRODOCK_ACME_EMAIL=%s\n' "$EMAIL" ;;
    ASTRODOCK_ADMIN_EMAIL=*)            printf 'ASTRODOCK_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL" ;;
    ASTRODOCK_ADMIN_PASSWORD=*)         printf 'ASTRODOCK_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" ;;
    ASTRODOCK_SETUP_TOKEN=*)            printf 'ASTRODOCK_SETUP_TOKEN=%s\n' "$SETUP_TOKEN" ;;
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
echo ""
echo "✓ Wrote $OUT — five secrets generated, permissions set to 600."
echo ""
if [ "$UP" != 1 ]; then
  echo "Next:  docker compose up -d"
  echo ""
fi
if [ -n "$DOMAIN" ]; then
  SCHEME=$([ "$TLS" = "off" ] && echo http || echo https)
  echo "  Dashboard:  $SCHEME://admin.$DOMAIN"
  [ "$LOCAL" != 1 ] && echo "  DNS:        point a wildcard record  *.$DOMAIN  at this server, and allow ports 80/443."
else
  echo "  Then open   http://<your-server-ip>"
  echo ""
  echo "  Finish setup there: it walks you through creating the administrator"
  echo "  account, choosing a domain, showing you the exact DNS record to add,"
  echo "  checking that record, and switching on HTTPS."
fi
if [ -n "$ADMIN_EMAIL" ]; then
  :
elif [ -n "$SETUP_TOKEN" ]; then
  echo ""
  echo "  Claim the dashboard with the setup token you supplied."
else
  echo ""
  echo "  The first-run setup token is printed by the control plane on boot:"
  echo "    docker compose logs api | grep -A2 'first-run setup'"
fi
echo ""

if [ "$UP" = 1 ]; then
  echo "Starting the stack…"
  ( cd "$REPO" && docker compose up -d )
  echo ""
  echo "Done. Check progress with:  docker compose ps"
fi
exit 0
