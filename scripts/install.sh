#!/bin/sh
# Astrodock installer. Intended to be piped from the web:
#
#   curl -fsSL https://get.astrodock.dev | sh
#
# It installs no source tree and builds nothing: it installs Docker if the machine
# does not have it, fetches the compose file and the env template, generates every
# secret, pulls the prebuilt images, and starts the stack. The domain and the
# administrator account are then set in the browser at http://<this-server-ip> —
# that is the entire install.
#
# Environment overrides (all optional):
#   ASTRODOCK_DIR       install location            (default /opt/astrodock)
#   ASTRODOCK_PROJECT   compose project name        (default astrodock) — set this
#                       AND ASTRODOCK_DIR to run a second, independent stack
#   ASTRODOCK_VERSION   image tag to run            (default latest)
#   ASTRODOCK_IMAGE     image repository            (default ghcr.io/astrodock/astrodock)
#   ASTRODOCK_REF       git ref to fetch files from (default main)
#   ASTRODOCK_NO_START  set to 1 to write files but not start
#   ASTRODOCK_INSTALL_DOCKER  set to 0 to refuse rather than install Docker when
#                       it is missing (default: install it, via get.docker.com)
#
# Unattended / cloud-init use (see docs/install-digitalocean.html):
#   ASTRODOCK_SETUP_TOKEN     choose the first-run token yourself, so you never
#                             have to read it out of the container logs — this is
#                             what lets a cloud install skip SSH entirely
#   ASTRODOCK_ADMIN_EMAIL     seed the admin account directly and skip the
#   ASTRODOCK_ADMIN_PASSWORD  claim step (see the caveat in .env.example)
#   ASTRODOCK_REGISTRY_USER   sign in to the image registry, for private images.
#   ASTRODOCK_REGISTRY_TOKEN  Use these rather than a `docker login` line ahead of
#                             this script: on a stock image Docker does not exist
#                             yet at that point, so the login silently fails.
#
# Deliberately NOT supported here: presetting the base domain. If DNS is not live
# yet, a configured domain means Caddy serves only that hostname and cannot get a
# certificate for it — leaving the box unreachable at both the domain AND the IP,
# with no wizard to fix it from. Set the domain in the browser, where DNS can be
# checked first.
set -eu

DIR="${ASTRODOCK_DIR:-/opt/astrodock}"
# Compose project name. Namespaces containers, volumes AND the docker network the
# runner attaches Dockerfile apps to (see docker-compose.yml) — so it is exported,
# not just passed to `up`, or the two would disagree.
PROJECT="${ASTRODOCK_PROJECT:-astrodock}"
export ASTRODOCK_PROJECT="$PROJECT"
REF="${ASTRODOCK_REF:-main}"
RAW="${ASTRODOCK_RAW_BASE:-https://raw.githubusercontent.com/astrodock/astrodock}/$REF"

say()  { printf '%s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── preflight ─────────────────────────────────────────────────────────────────
# Install Docker if it is missing. This matters most in the flow that has no
# terminal: pasting this into a cloud provider's user-data field, on a stock
# Ubuntu image, where telling the operator to "install Docker first" is advice
# nobody is present to read. Set ASTRODOCK_INSTALL_DOCKER=0 to refuse instead.
if ! have docker; then
  if [ "${ASTRODOCK_INSTALL_DOCKER:-1}" = "0" ]; then
    die "Docker is not installed, and ASTRODOCK_INSTALL_DOCKER=0. Install it with:  curl -fsSL https://get.docker.com | sh"
  fi
  [ "$(id -u)" = "0" ] || die "Docker is not installed and this is not running as root. Either run as root, or install Docker first:  curl -fsSL https://get.docker.com | sh"
  say "Docker is not installed — installing it from get.docker.com…"
  if have curl; then curl -fsSL https://get.docker.com | sh
  elif have wget; then wget -qO- https://get.docker.com | sh
  else die "Need curl or wget to install Docker."
  fi
  have docker || die "Docker installation did not produce a working 'docker' command. Install it manually and re-run."
fi

docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install Docker v2+ (curl -fsSL https://get.docker.com | sh)."

# A just-installed daemon can take a moment to accept connections, and on a
# cloud-init run there is nobody watching to retry.
if ! docker info >/dev/null 2>&1; then
  have systemctl && systemctl start docker >/dev/null 2>&1 || true
  i=0
  while [ "$i" -lt 15 ]; do
    docker info >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 2
  done
fi
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Start it (systemctl start docker), or re-run this as root."

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

# Compose identifies a stack by PROJECT NAME, not by directory. Installing while a
# stack of the same name exists would adopt its containers and restart them against
# the secrets generated below — and since the database volume keeps the password it
# was initialised with, the api then crash-loops on an auth error that says nothing
# about the cause. The $DIR/.env check above misses this whenever the other stack
# lives in a different directory, which is the normal case.
#
# Refusing outright would leave someone with an existing install unable to stand up
# a second one at all, so instead: refuse the COLLISION, and offer the way round it.
if docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' 2>/dev/null | grep -q .; then
  say "" >&2
  say "error: a Compose stack named '$PROJECT' already exists on this machine." >&2
  say "" >&2
  say "Installing over it would restart its containers with the new secrets this" >&2
  say "script generates, which breaks it — the database keeps the old password." >&2
  say "" >&2
  say "  See it with:            docker compose ls" >&2
  say "  Upgrade that one:       cd <its dir> && docker compose pull && docker compose up -d" >&2
  say "  Or install alongside:   ASTRODOCK_PROJECT=astrodock2 ASTRODOCK_DIR=/opt/astrodock2 …" >&2
  say "                          (a separate stack with its own empty database)" >&2
  exit 1
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
printf 'ASTRODOCK_PROJECT=%s\n' "$PROJECT" >> "$tmp"
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
# Pulling images takes a couple of minutes, and until Caddy is up port 80 refuses
# connections. Someone who was told "open http://<your-ip> when it's ready" sees a
# browser error and reasonably concludes the install failed — which is exactly what
# happened the first time this was tried on a real droplet. So hold the port with a
# placeholder that says what is going on.
#
# Entirely best-effort: an install must never fail because the reassurance failed.
PLACEHOLDER=astrodock-installing
stop_placeholder() { docker rm -f "$PLACEHOLDER" >/dev/null 2>&1 || true; }

serve_page() { # serve_page <html> — best-effort, replaces any existing placeholder
  stop_placeholder
  docker run -d --name "$PLACEHOLDER" -p 80:80 caddy:2-alpine \
    caddy respond --listen :80 --status 200 --header "Content-Type: text/html; charset=utf-8" "$1" \
    >/dev/null 2>&1 || true
}

page() { # page <title> <body-html>
  printf '%s' "<!doctype html><meta charset=\"utf-8\"><title>$1</title><style>body{font-family:system-ui,sans-serif;background:#f4f6fa;color:#1a2233;display:grid;place-items:center;height:100vh;margin:0}div{max-width:38rem;padding:2rem}h1{font-weight:650;font-size:1.4rem;margin:0 0 .8rem}p{margin:.5rem 0;color:#556;line-height:1.5}code{background:#e6e9f0;padding:.15rem .4rem;border-radius:4px;font-size:.9em}</style><div><h1>$1</h1>$2</div>"
}

# Fail LOUDLY on the port the operator is watching. Tearing the placeholder down on
# failure — which is what this used to do — turns a diagnosable error into a bare
# connection-refused, and the real reason ends up buried in cloud-init's log on a
# box the operator may never have opened a terminal on.
fail_with_page() {
  serve_page "$(page 'Astrodock could not finish installing' \
    "<p>$1</p><p>The full log is on the server at <code>/var/log/cloud-init-output.log</code>, or from <code>cd $DIR &amp;&amp; docker compose logs</code>.</p>")"
  die "$1"
}

say "Pulling images…"
if docker pull -q caddy:2-alpine >/dev/null 2>&1; then
  serve_page '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>Astrodock is installing</title><style>body{font-family:system-ui,sans-serif;background:#f4f6fa;color:#1a2233;display:grid;place-items:center;height:100vh;margin:0}div{max-width:34rem;padding:2rem;text-align:center}h1{font-weight:650;font-size:1.4rem;margin:0 0 .6rem}p{margin:.4rem 0;color:#556}</style><div><h1>Astrodock is installing</h1><p>Downloading and starting the platform. This usually takes a minute or two on a small server.</p><p>This page refreshes itself — setup will appear here when it is ready.</p></div>'
fi

# Registry sign-in, for private images. Done HERE rather than by the caller: a
# `docker login` line in a user-data script runs BEFORE this script has had the
# chance to install Docker, so on a stock image it fails with "docker: not found"
# and nothing notices until the pull below dies minutes later.
if [ -n "${ASTRODOCK_REGISTRY_TOKEN:-}" ]; then
  REG_HOST=$(printf '%s' "${ASTRODOCK_IMAGE:-ghcr.io/astrodock/astrodock}" | cut -d/ -f1)
  say "Signing in to $REG_HOST…"
  printf '%s' "$ASTRODOCK_REGISTRY_TOKEN" \
    | docker login "$REG_HOST" -u "${ASTRODOCK_REGISTRY_USER:-oauth2}" --password-stdin >/dev/null 2>&1 \
    || fail_with_page "Could not sign in to $REG_HOST. Check ASTRODOCK_REGISTRY_USER and ASTRODOCK_REGISTRY_TOKEN."
fi

if ! docker compose pull -q; then
  fail_with_page "Could not download the Astrodock images. If they are private, set ASTRODOCK_REGISTRY_USER and ASTRODOCK_REGISTRY_TOKEN. Otherwise check the image name and tag, or build from source using docker-compose.build.yml."
fi

say "Starting…"
# Free port 80 for Caddy before compose claims it.
stop_placeholder
if ! docker compose up -d; then
  die "The stack failed to start. Inspect it with:  cd $DIR && docker compose logs"
fi

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
