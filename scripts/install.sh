#!/bin/sh
# Astrodock installer. Intended to be piped from the web:
#
#   curl -fsSL https://get.astrodock.dev | sh
#
# It installs no source tree and builds nothing: it fetches the compose file and
# the env template, generates every secret, pulls the prebuilt images, and starts
# the stack. The domain and the administrator account are then set in the browser
# at http://<this-server-ip> — that is the entire install.
#
# Environment overrides (all optional):
#   ASTRODOCK_DIR       install location            (default /opt/astrodock)
#   ASTRODOCK_VERSION   image tag to run            (default latest)
#   ASTRODOCK_IMAGE     image repository            (default ghcr.io/astrodock/astrodock)
#   ASTRODOCK_REF       git ref to fetch files from (default main)
#   ASTRODOCK_NO_START  set to 1 to write files but not start
#
# Unattended / cloud-init use (see docs/install-digitalocean.html):
#   ASTRODOCK_SETUP_TOKEN     choose the first-run token yourself, so you never
#                             have to read it out of the container logs — this is
#                             what lets a cloud install skip SSH entirely
#   ASTRODOCK_ADMIN_EMAIL     seed the admin account directly and skip the
#   ASTRODOCK_ADMIN_PASSWORD  claim step (see the caveat in .env.example)
#
# Deliberately NOT supported here: presetting the base domain. If DNS is not live
# yet, a configured domain means Caddy serves only that hostname and cannot get a
# certificate for it — leaving the box unreachable at both the domain AND the IP,
# with no wizard to fix it from. Set the domain in the browser, where DNS can be
# checked first.
set -eu

DIR="${ASTRODOCK_DIR:-/opt/astrodock}"
REF="${ASTRODOCK_REF:-main}"
RAW="${ASTRODOCK_RAW_BASE:-https://raw.githubusercontent.com/astrodock/astrodock}/$REF"

say()  { printf '%s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── preflight ─────────────────────────────────────────────────────────────────
have docker || die "Docker is not installed. Install it first:  curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install Docker v2+ (curl -fsSL https://get.docker.com | sh)."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Start it, or re-run this as root."

if have curl; then fetch() { curl -fsSL "$1" -o "$2"; }
elif have wget; then fetch() { wget -qO "$2" "$1"; }
else die "Need curl or wget to download the compose file."
fi

rand() {
  if have openssl; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n'; fi
}

# ── install location ──────────────────────────────────────────────────────────
if ! mkdir -p "$DIR" 2>/dev/null; then
  die "Cannot create $DIR. Re-run as root, or set ASTRODOCK_DIR to somewhere writable."
fi
cd "$DIR"

if [ -f "$DIR/.env" ]; then
  say ""
  say "Astrodock is already installed in $DIR."
  say "To upgrade:   cd $DIR && docker compose pull && docker compose up -d"
  say "To start over, remove $DIR first (this deletes your configuration)."
  exit 0
fi

# ── fetch ─────────────────────────────────────────────────────────────────────
say "Fetching Astrodock…"
fetch "$RAW/docker-compose.yml" "$DIR/docker-compose.yml" || die "Could not download docker-compose.yml from $RAW"
fetch "$RAW/.env.example" "$DIR/.env.example" || die "Could not download .env.example from $RAW"

# The bootstrap Caddyfile is bind-mounted by the caddy service, so it must exist on
# disk before `docker compose up`. Without it Docker helpfully creates a DIRECTORY
# at that path and then fails to mount it over a file, with an error that says
# nothing about the real cause. It is the only host path the compose file needs —
# keep this in step with the `./` bind mounts in docker-compose.yml.
mkdir -p "$DIR/infra/caddy"
fetch "$RAW/infra/caddy/Caddyfile" "$DIR/infra/caddy/Caddyfile" || die "Could not download infra/caddy/Caddyfile from $RAW"

# ── configure ─────────────────────────────────────────────────────────────────
# Same managed-key substitution as scripts/setup.sh, kept promptless on purpose:
# the only values a human must choose (domain, admin account) are collected by the
# first-run wizard, which can also verify DNS — a shell script cannot.
say "Generating secrets…"
JWT=$(rand); SECRET=$(rand); RUNNER=$(rand); PGPW=$(rand); OBJ=$(rand)

tmp="$DIR/.env.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM
: > "$tmp"
chmod 600 "$tmp"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ASTRODOCK_ADMIN_JWT_SECRET=*)       printf 'ASTRODOCK_ADMIN_JWT_SECRET=%s\n' "$JWT" ;;
    ASTRODOCK_SECRET_KEY=*)             printf 'ASTRODOCK_SECRET_KEY=%s\n' "$SECRET" ;;
    ASTRODOCK_RUNNER_TOKEN=*)           printf 'ASTRODOCK_RUNNER_TOKEN=%s\n' "$RUNNER" ;;
    ASTRODOCK_PG_PASSWORD=*)            printf 'ASTRODOCK_PG_PASSWORD=%s\n' "$PGPW" ;;
    ASTRODOCK_OBJECTSTORE_SECRET_KEY=*) printf 'ASTRODOCK_OBJECTSTORE_SECRET_KEY=%s\n' "$OBJ" ;;
    # Unattended passthrough: only written when actually supplied, so the template's
    # blank line (and the browser-setup default) survives otherwise.
    ASTRODOCK_SETUP_TOKEN=*)            printf 'ASTRODOCK_SETUP_TOKEN=%s\n' "${ASTRODOCK_SETUP_TOKEN:-}" ;;
    ASTRODOCK_ADMIN_EMAIL=*)            printf 'ASTRODOCK_ADMIN_EMAIL=%s\n' "${ASTRODOCK_ADMIN_EMAIL:-}" ;;
    ASTRODOCK_ADMIN_PASSWORD=*)         printf 'ASTRODOCK_ADMIN_PASSWORD=%s\n' "${ASTRODOCK_ADMIN_PASSWORD:-}" ;;
    *)                                  printf '%s\n' "$line" ;;
  esac
done < "$DIR/.env.example" > "$tmp"

# Pin the image tag that was actually installed, so a later `docker compose up`
# on this box can't silently jump versions.
[ -n "${ASTRODOCK_VERSION:-}" ] && printf 'ASTRODOCK_VERSION=%s\n' "$ASTRODOCK_VERSION" >> "$tmp"
[ -n "${ASTRODOCK_IMAGE:-}" ] && printf 'ASTRODOCK_IMAGE=%s\n' "$ASTRODOCK_IMAGE" >> "$tmp"

mv "$tmp" "$DIR/.env"
chmod 600 "$DIR/.env"
trap - EXIT INT TERM

if [ "${ASTRODOCK_NO_START:-0}" = "1" ]; then
  say "Wrote $DIR/.env and $DIR/docker-compose.yml. Start it with:  cd $DIR && docker compose up -d"
  exit 0
fi

# ── start ─────────────────────────────────────────────────────────────────────
say "Pulling images…"
docker compose pull -q || die "Image pull failed. Check the tag/repository, or build from source (see docker-compose.build.yml)."
say "Starting…"
docker compose up -d || die "The stack failed to start. Inspect it with:  cd $DIR && docker compose logs"

# Best-effort: the address the operator should open. We ask the routing table which
# source address reaches the internet — no external service, no outbound request.
IP=""
if have ip; then IP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1); fi
[ -n "$IP" ] || IP="<your-server-ip>"

say ""
say "  ┌─ Astrodock is starting ───────────────────────────────────"
say "  │"
say "  │  Open   http://$IP"
say "  │"
say "  │  Finish setup there: create the administrator account,"
say "  │  choose your domain, add the DNS record it shows you,"
say "  │  and switch on HTTPS."
say "  │"
if [ -n "${ASTRODOCK_ADMIN_EMAIL:-}" ]; then
  say "  │  The administrator account was seeded at install time —"
  say "  │  sign in as ${ASTRODOCK_ADMIN_EMAIL}."
elif [ -n "${ASTRODOCK_SETUP_TOKEN:-}" ]; then
  say "  │  Use the setup token you supplied at install time."
else
  say "  │  The one-time setup token is in the logs:"
  say "  │    cd $DIR && docker compose logs api | grep -A2 'first-run setup'"
fi
say "  └───────────────────────────────────────────────────────────"
say ""
