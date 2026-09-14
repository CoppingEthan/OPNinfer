#!/usr/bin/env bash
#
# OPNinfer — one-command deploy & update for EVERY instance on this host.
#
#   First run:            installs Docker if missing, then walks you through
#                         creating your portal instances (name + domain each).
#                         Every instance gets its own env file, secrets,
#                         database and storage — fully isolated from the rest.
#
#   Every run after that: pulls the latest code from GitHub, rebuilds the
#                         images once, and rolling-updates the shared engines
#                         AND every instance. Data/volumes are never touched;
#                         migrations apply automatically per instance.
#
#   Usage:  ./deploy.sh          # deploy/update everything (wizard on first run)
#           ./deploy.sh add      # add another instance, then deploy it
#
# Layout on this host:
#   instances/<name>.env        one file per portal (git-ignored, chmod 600)
#   engines.env                 shared-engine tunables (WHISPER_MODEL, TTS_IMAGE)
#   docker-compose.yml          ONE instance stack (db/app/worker/sandboxd)
#   docker-compose.engines.yml  SHARED engines (gotenberg/docling/whisper/kokoro)
#
# Each instance publishes plain HTTP on its own port (3001, 3002, …) bound to
# 0.0.0.0 — point your reverse proxy at http://<this-host>:<port>. TLS is the
# reverse proxy's job; there is no bundled TLS terminator.
set -euo pipefail
cd "$(dirname "$0")"

# --- pretty output ----------------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '\033[36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- docker: check, install if missing, pick sudo or not --------------------
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

install_docker() {
  info "Docker not found — installing via get.docker.com (official script)…"
  command -v curl >/dev/null 2>&1 || { info "Installing curl…"; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl; }
  curl -fsSL https://get.docker.com | $SUDO sh || die "Docker installation failed — install manually: https://docs.docker.com/engine/install/"
  $SUDO systemctl enable --now docker 2>/dev/null || true
  ok "Docker installed."
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || install_docker
  # Compose v2 plugin (get.docker.com includes it; older installs may not).
  if ! docker compose version >/dev/null 2>&1 && ! $SUDO docker compose version >/dev/null 2>&1; then
    info "Installing the Docker Compose v2 plugin…"
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq docker-compose-plugin \
      || die "Couldn't install docker-compose-plugin — install it manually."
  fi
  # Daemon reachable? Prefer no sudo; fall back to sudo (fresh installs where
  # this user isn't in the 'docker' group yet).
  if docker info >/dev/null 2>&1; then
    DKR="docker"
  elif $SUDO docker info >/dev/null 2>&1; then
    DKR="$SUDO docker"
    warn "Using sudo for docker (user '$USER' isn't in the 'docker' group)."
    warn "Optional: $SUDO usermod -aG docker $USER  — then log out/in to drop sudo."
  else
    die "Can't reach the Docker daemon. Is it running? (systemctl status docker)"
  fi
  # The sandbox mounts per-chat volume SUBPATHS — that needs Docker Engine 26+.
  local ver major
  ver="$($DKR version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
  major="${ver%%.*}"
  case "$major" in
    ''|*[!0-9]*) warn "Couldn't parse Docker version '$ver' — sandbox needs Engine 26+." ;;
    *) [ "$major" -ge 26 ] || warn "Docker Engine $ver detected — the code sandbox needs 26+. Everything else works; upgrade Docker to enable sandboxed code execution." ;;
  esac
}
ensure_docker
dc() { $DKR compose "$@"; }

# --- storage preflight ------------------------------------------------------
# Docker 29 keeps images and snapshots in CONTAINERD's store, which does NOT
# follow daemon.json's `data-root`. Setting data-root alone therefore moves
# only half of Docker's footprint — the images keep landing on the boot disk
# and fill it. Found the hard way on the first production host (root hit 98%
# mid-deploy). Warn before we pull ~7 GB of images rather than after.
# Overridable so the regression test can drive the config-parsing branch with a
# file of its own (a stock host's config has no uncommented `root =` line, which
# is exactly the case that used to kill the deploy).
CONTAINERD_CONFIG="${CONTAINERD_CONFIG:-/etc/containerd/config.toml}"

preflight_storage() {
  local docker_root containerd_root docker_fs containerd_fs avail_gb
  docker_root="$($DKR info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  containerd_root="/var/lib/containerd"
  if [ -f "$CONTAINERD_CONFIG" ]; then
    local configured
    # `|| true` is load-bearing: under `set -euo pipefail` a grep that matches
    # nothing exits 1, pipefail carries that out of the substitution, and the
    # WHOLE DEPLOY dies right here with no message — on any host whose
    # containerd config has no uncommented `root =` line, which is the packaged
    # default. A warning function must never be able to end the run. Same class
    # of bug as the deploy-token grep that once left production un-updated.
    configured="$(grep -E '^\s*root\s*=' "$CONTAINERD_CONFIG" 2>/dev/null \
      | head -1 | sed 's/.*=\s*"\(.*\)".*/\1/' || true)"
    [ -n "$configured" ] && containerd_root="$configured"
  fi

  IMAGE_STORE_DIR="$containerd_root"
  docker_fs="$(df -P "$docker_root" 2>/dev/null | awk 'NR==2{print $1}' || true)"
  containerd_fs="$(df -P "$containerd_root" 2>/dev/null | awk 'NR==2{print $1}' || true)"

  if [ -n "$docker_fs" ] && [ -n "$containerd_fs" ] && [ "$docker_fs" != "$containerd_fs" ]; then
    warn "Docker's data-root and containerd's store are on DIFFERENT disks:"
    warn "  docker     $docker_root  ($docker_fs)"
    warn "  containerd $containerd_root  ($containerd_fs)"
    warn "Images live in containerd's store, so they'll fill $containerd_fs."
    warn "To move it too (Docker 29+):"
    warn "  sudo systemctl stop docker docker.socket containerd"
    warn "  sudo sed -i '1i root = \"<your-data-disk>/containerd\"' /etc/containerd/config.toml"
    warn "  sudo mv /var/lib/containerd <your-data-disk>/containerd"
    warn "  sudo systemctl start containerd docker"
    echo
  fi

  # ~7 GB of images plus each instance's database and files. Below 20 GB free
  # on the image store, a first-time deploy is likely to run the disk out.
  avail_gb="$(df -PBG "$containerd_root" 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}' || true)"
  if [ -n "$avail_gb" ] && [ "$avail_gb" -lt 20 ] 2>/dev/null; then
    warn "Only ${avail_gb} GB free where images are stored ($containerd_root)."
    warn "The images alone need ~7 GB; 20 GB+ free is recommended before deploying."
    echo
  fi
}
# Belt and braces: even if something in there still fails, a storage WARNING
# must never stop the update.
preflight_storage || true

# --- disk hygiene -----------------------------------------------------------
# Every deploy leaves the previous build's layers behind as untagged images, and
# BuildKit's cache grows without bound. On this host that is a slow-motion
# outage: the image store shares a disk with every instance's database and
# files, and the first production deploy already filled it to 98%.
#
# What this deliberately does NOT do is `system prune -a` or `image prune -a`.
# Those delete TAGGED images merely because nothing is running them right now —
# including the four shared engine images, ~7 GB to pull back — which turns a
# tidy-up into an outage. Only untagged leftovers, old exited containers and
# STALE build cache go.
#
# Set OPNINFER_SKIP_CLEANUP=1 to keep everything (e.g. while bisecting a bad
# image).
free_gb() {
  df -PBG "${IMAGE_STORE_DIR:-/var/lib/docker}" 2>/dev/null     | awk 'NR==2{gsub("G","",$4); print $4}' || true
}

# Run a prune and echo what IT says it reclaimed ("1.23GB"). Reading docker's
# own total beats diffing `df`, which reports whole gigabytes and so announced
# "0 GB reclaimed" after genuinely clearing several hundred megabytes.
# Docker 28+ can cap the build cache by size; older versions only by age.
builder_supports_max_space() {
  $DKR builder prune --help 2>/dev/null | grep -q -- '--max-used-space'
}

prune_reclaimed() {
  local out
  # Two output formats (found 2026-09-04): the classic prunes end with
  # "Total reclaimed space: 1.2GB", but `builder prune` is served by buildx
  # and ends with "Total:<TAB>1.2GB" — the old pattern never matched it, so
  # every deploy printed "build cache 0B" whatever it had freed.
  out="$("$@" 2>/dev/null | grep -iE '^total( reclaimed space)?:' | tail -1 || true)"
  out="${out##*:}"
  out="${out//[[:space:]]/}"
  echo "${out:-0B}"
}

reclaim_space() {
  if [ "${OPNINFER_SKIP_CLEANUP:-0}" = "1" ]; then
    info "Skipping cleanup (OPNINFER_SKIP_CLEANUP=1)."
    return 0
  fi
  info "Reclaiming disk space…"
  local after img cnt cache

  # 1. Untagged images: the previous build of each of our four images, plus any
  #    intermediate left behind. Nothing running can be dangling.
  img="$(prune_reclaimed $DKR image prune -f)"
  # 2. Exited containers older than a day — old one-shot `migrate` runs, reaped
  #    sandboxes. Today's are kept so a failed deploy can still be inspected.
  cnt="$(prune_reclaimed $DKR container prune -f --filter until=24h)"
  # 3. Build cache, capped by SIZE — not just age.
  #
  #    An age filter alone was wrong here, and the first run proved it: on a
  #    host that deploys weekly nothing is 14 days idle, so it reported "build
  #    cache 0B" while the cache itself kept growing on a disk already under the
  #    warning threshold. `--max-used-space` keeps the most recently used
  #    entries — the pnpm store and Next's compiler cache, which are exactly
  #    what makes the next deploy quick — and evicts the rest. Older Docker
  #    without the flag falls back to the age filter.
  #
  #    `--all` is load-bearing (found live 2026-09-02): without it `builder
  #    prune` only touches DANGLING cache — entries no build references —
  #    which on a host that keeps rebuilding the same images is nothing. So
  #    the cap said "0B" while 14 GB sat there with 5 GB reclaimable. With
  #    `--all` the cap keeps the most recently USED entries (the pnpm store
  #    and Next's compiler cache, minutes old) and evicts the rest. This is
  #    build cache only — nothing here can touch an image.
  if builder_supports_max_space; then
    cache="$(prune_reclaimed $DKR builder prune -f --all --max-used-space "${OPNINFER_BUILD_CACHE_MAX:-10GB}")"
  else
    cache="$(prune_reclaimed $DKR builder prune -f --all --filter until=336h)"
  fi
  # 4. Legacy (v0.4): the pre-agent exec-tier sandbox containers (`oi-sbx-*`)
  #    and the original un-suffixed egress network. sandboxd reaps LABELLED
  #    ones at boot; the earliest carried no label and would otherwise sit
  #    forever, each holding a pool mount. Explicit names only — never a
  #    blanket container/network prune.
  local legacy
  legacy="$($DKR ps -aq --filter 'name=^oi-sbx-' 2>/dev/null || true)"
  if [ -n "$legacy" ]; then
    # shellcheck disable=SC2086
    $DKR rm -f $legacy >/dev/null 2>&1 || true
    info "  removed $(printf '%s\n' "$legacy" | grep -c . || true) legacy sandbox container(s)"
  fi
  if $DKR network inspect opninfer_sandbox_egress >/dev/null 2>&1; then
    $DKR network rm opninfer_sandbox_egress >/dev/null 2>&1 && info "  removed the legacy sandbox network" || true
  fi
  info "  images $img · containers $cnt · build cache $cache"

  after="$(free_gb)"
  # If the disk is still tight, take the stale-cache window down to 48h. Still
  # not a full cache wipe — an entry used by the build that just ran is not
  # 48 hours idle, so the caches that matter survive.
  case "$after" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$after" -lt 15 ]; then
        warn "  still only ${after} GB free — trimming the build cache further"
        if builder_supports_max_space; then
          cache="$(prune_reclaimed $DKR builder prune -f --all --max-used-space 4GB)"
        else
          cache="$(prune_reclaimed $DKR builder prune -f --all --filter until=48h)"
        fi
        info "  build cache (tighter) $cache"
        after="$(free_gb)"
      fi
      # Whatever is left, SAY where the space went. "0B reclaimed" with no
      # context is what sent me looking in the wrong place the first time.
      $DKR system df 2>/dev/null | sed 's/^/    /' || true
      ;;
  esac

  case "$after" in
    ''|*[!0-9]*) ok "  cleanup done" ;;
    *) ok "  cleanup done — ${after} GB free on ${IMAGE_STORE_DIR:-the image store}" ;;
  esac
}

# --- secrets ----------------------------------------------------------------
# 32 random bytes, base64 — matches 'openssl rand -base64 32'. Falls back to
# /dev/urandom when openssl isn't on the host.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  else head -c 32 /dev/urandom | base64; fi
}
# URL-safe token (no /+=) for DATABASE_URL passwords + the sandbox token.
gen_token() { gen_secret | tr -dc 'A-Za-z0-9' | cut -c1-32; }

# --- instance helpers -------------------------------------------------------
mkdir -p instances

next_free_port() {
  local port=3001
  while grep -hs "^APP_PORT=\"$port\"" instances/*.env >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

create_instance() {
  echo
  read -rp "Instance name (short, e.g. acme — blank to stop adding): " RAW
  [ -n "$RAW" ] || return 1
  # Sanitize: lowercase letters/digits/dashes (used in docker project/volume names).
  local NAME
  NAME="$(printf '%s' "$RAW" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')"
  [ -n "$NAME" ] || { warn "Name '$RAW' has no usable characters — try again."; return 0; }
  [ ! -f "instances/$NAME.env" ] || { warn "Instance '$NAME' already exists — skipping."; return 0; }

  read -rp "  Public domain for $NAME (e.g. chat.acme.example): " DOMAIN
  [ -n "$DOMAIN" ] || { warn "A domain is required (your reverse proxy routes on it) — skipping '$NAME'."; return 0; }
  local PORT; PORT="$(next_free_port)"
  read -rp "  Local port for the reverse proxy to target [$PORT]: " P2
  PORT="${P2:-$PORT}"

  info "Generating secrets for '$NAME'…"
  local AUTH_SECRET MASTER_KEY PG_PASSWORD SANDBOX_TOKEN DEPLOY_TOKEN
  AUTH_SECRET="$(gen_secret)"
  MASTER_KEY="$(gen_secret)"
  PG_PASSWORD="$(gen_token)"
  SANDBOX_TOKEN="$(gen_token)"
  DEPLOY_TOKEN="$(gen_token)"

  umask 077
  cat > "instances/$NAME.env" <<EOF
# OPNinfer instance "$NAME" — generated by deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Git-ignored — do NOT commit. Edit and re-run ./deploy.sh to apply changes.
INSTANCE_ENV="instances/$NAME.env"
INSTANCE_NAME="$NAME"

# Your reverse proxy serves https://\$DOMAIN and forwards to this host's port.
DOMAIN="$DOMAIN"
AUTH_URL="https://$DOMAIN"
APP_PORT="$PORT"

POSTGRES_USER="opninfer"
POSTGRES_PASSWORD="$PG_PASSWORD"
POSTGRES_DB="opninfer"
DATABASE_URL="postgresql://opninfer:$PG_PASSWORD@db:5432/opninfer?schema=public&connection_limit=15&pool_timeout=20"

AUTH_SECRET="$AUTH_SECRET"
# Master key for provider-key encryption at rest. BACK THIS UP — without it,
# this instance's stored provider keys are unrecoverable.
OPNINFER_MASTER_KEY="$MASTER_KEY"

OPNINFER_TENANT_ID="default"
# Names THIS portal's sandbox containers, labels and egress network apart from
# every other instance sharing the Docker daemon.
OPNINFER_INSTANCE="$NAME"
OPNINFER_STORAGE_ROOT="/app/storage"
OPNINFER_MAX_UPLOAD_BYTES="52428800"

# Lets deploy.sh ask this instance to finish its in-flight replies before the
# container is replaced (POST /api/admin/drain). Remove it to disable draining.
OPNINFER_DEPLOY_TOKEN="$DEPLOY_TOKEN"

# Sandbox (agentic tools): per-instance broker secret + THIS instance's
# storage-volume name (must match the compose project prefix).
SANDBOX_BROKER_TOKEN="$SANDBOX_TOKEN"
STORAGE_VOLUME="opninfer-${NAME}_storage"
# Sandbox internet: "egress" (default — internet yes, internal network no)
# or "none" for fully offline sandboxes.
# SANDBOX_NETWORK="egress"

# Reply-TTS voice (af_heart default; British: bf_emma / bm_george).
# TTS_VOICE="af_heart"

# SMTP is optional — configure it later in Admin → SMTP, or uncomment here.
# SMTP_HOST=""
# SMTP_PORT="587"
# SMTP_SECURE="false"
# SMTP_USER=""
# SMTP_PASS=""
# SMTP_FROM="OPNinfer <noreply@$DOMAIN>"
EOF
  chmod 600 "instances/$NAME.env"
  ok "Created instances/$NAME.env  (port $PORT, https://$DOMAIN)"
  NEW_INSTANCES=1
  return 0
}

wizard() {
  bold "OPNinfer — instance setup"
  echo "Each instance is an isolated portal (own database, files, admin, keys)."
  echo "Add as many as you like; press Enter on a blank name when done."
  while create_instance; do :; done
}

# --- first run / add --------------------------------------------------------
# Carried across a self-update re-exec so the "next steps for each new
# instance" block still prints for an instance created before the restart.
NEW_INSTANCES="${OPNINFER_NEW_INSTANCES:-0}"
# How long a drain waits for replies in flight before the container is
# replaced. Read here rather than beside the deploy loop because the
# agent-token subcommand below also drains, and exits long before that
# loop is reached (a `set -u` script would die on an unset value).
DRAIN_WAIT_SECONDS="${DRAIN_WAIT_SECONDS:-60}"

# EVERY command in here must be failure-tolerant. This script runs under
# `set -euo pipefail`, so a bare `grep` that finds nothing, or a `curl` to an
# instance that isn't up, aborts the WHOLE DEPLOY. That is exactly what
# happened the first time this shipped: an instance with no token yet (i.e.
# every instance that predates draining) died at "Deploying instance…" before
# anything was restarted. Hence `|| true` on each pipeline, and `|| true` on
# the call site too.
drain_instance() {
  local name="$1" env_file="$2" port="$3"
  local token
  token="$(grep -E '^OPNINFER_DEPLOY_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d'"' -f2 || true)"
  [ -n "$token" ] || return 0

  local url="http://127.0.0.1:$port/api/admin/drain"
  local body
  body="$(curl -s --max-time 5 -X POST -H "Authorization: Bearer $token" "$url" || true)"
  case "$body" in
    *'"draining":true'*) ;;
    *) return 0 ;;  # not running, or too old to know about draining
  esac

  info "  draining '$name' (up to ${DRAIN_WAIT_SECONDS}s for replies in flight)…"
  local waited=0 active
  while [ "$waited" -lt "$DRAIN_WAIT_SECONDS" ]; do
    active="$(curl -s --max-time 5 -H "Authorization: Bearer $token" "$url" 2>/dev/null \
      | sed -n 's/.*"activeTurns":\([0-9]*\).*/\1/p' || true)"
    # Anything non-numeric (empty reply, the app restarting, garbage) counts as
    # "don't know" → keep waiting rather than crash on `[ -eq ]`.
    case "$active" in
      ''|*[!0-9]*) active=-1 ;;
    esac
    if [ "$active" -eq 0 ]; then
      ok "  '$name' idle after ${waited}s — safe to restart"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  warn "  '$name' still had replies running after ${DRAIN_WAIT_SECONDS}s — restarting anyway"
}

# Clear the drain flag once the instance is back up.
#
# Usually redundant: the flag lives in memory, so a REPLACED container starts
# clear. But `up -d` deliberately leaves a container alone when its image and
# config are unchanged — which is exactly what a re-run with no new commits
# produces, and the script itself tells you to re-run after fixing a failed
# check. Without this, that re-run drains a healthy portal and never undrains
# it: every user gets "we're updating, try again in a couple of minutes" for
# ever, while the deploy prints "all checks passed" (the /login probe still
# answers). Best-effort, like every other nicety in this path.
undrain_instance() {
  local name="$1" env_file="$2" port="$3"
  local token
  token="$(grep -E '^OPNINFER_DEPLOY_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d'"' -f2 || true)"
  [ -n "$token" ] || return 0
  curl -s --max-time 5 -X DELETE -H "Authorization: Bearer $token"     "http://127.0.0.1:$port/api/admin/drain" >/dev/null 2>&1 || true
}

# `./deploy.sh agent-mcp <instance> …` — connected services (MCP) for the
# instance's Sandbox, e.g. Figma (2026-09-03). Thin wrappers over Claude
# Code's OWN commands, run inside that instance's agent credential volume, so
# the server list and its sign-in live where the Claude sign-in already lives
# — nothing passes through OPNinfer, and only THIS instance's agents get the
# service. Sign-in is the service's own OAuth flow, headless: open the URL,
# approve, paste the redirect URL back.
#   add <name> <url> [--header 'Name: value']   register a remote (http) server
#   login <name> | list | remove <name> | logout <name>
agent_mcp() {
  local inst="${1:-}" sub="${2:-}"
  local usage="Usage: ./deploy.sh agent-mcp <instance> add <name> <url> [--header 'Name: value'] | login <name> | list | remove <name> | logout <name>"
  [ -n "$inst" ] && [ -n "$sub" ] || die "$usage"
  [ -f "instances/$inst.env" ] || die "No such instance: $inst (see instances/)"
  $DKR image inspect opninfer-agent >/dev/null 2>&1 || die "The agent image isn't built yet — run ./deploy.sh first."
  local vol="opninfer-agent-config-$inst"
  shift 2
  case "$sub" in
    add)
      local name="${1:-}" url="${2:-}"
      [ -n "$name" ] && [ -n "$url" ] || die "$usage"
      case "$url" in
        http://*|https://*) ;;
        *) die "agent-mcp add takes a remote server URL (http/https), got: $url" ;;
      esac
      shift 2
      $DKR run --rm -v "$vol:/home/sandbox/.claude" opninfer-agent \
        claude mcp add --transport http -s user "$name" "$url" "$@"
      ok "Added '$name' to the '$inst' Sandbox. If it needs a sign-in:  ./deploy.sh agent-mcp $inst login $name"
      ;;
    login)
      local name="${1:-}"
      [ -n "$name" ] || die "$usage"
      info "Signing the '$inst' Sandbox in to '$name'…"
      echo "  Open the URL it prints in a browser and approve. The browser then lands on a"
      echo "  localhost address that shows a connection error — that is expected: copy that"
      echo "  FULL address from the address bar and paste it back here."
      $DKR run -it --rm -v "$vol:/home/sandbox/.claude" opninfer-agent \
        claude mcp login "$name" --no-browser
      ;;
    list)
      $DKR run --rm -v "$vol:/home/sandbox/.claude" opninfer-agent claude mcp list
      ;;
    remove)
      local name="${1:-}"
      [ -n "$name" ] || die "$usage"
      $DKR run --rm -v "$vol:/home/sandbox/.claude" opninfer-agent claude mcp remove -s user "$name"
      ;;
    logout)
      local name="${1:-}"
      [ -n "$name" ] || die "$usage"
      $DKR run --rm -v "$vol:/home/sandbox/.claude" opninfer-agent claude mcp logout "$name"
      ;;
    *)
      die "Unknown agent-mcp command '$sub'. $usage"
      ;;
  esac
}
if [ "${1:-}" = "agent-mcp" ]; then
  shift
  agent_mcp "$@"
  exit $?
fi

# `./deploy.sh agent-token <instance>` — the OTHER way to run a Sandbox on a
# Claude plan, and the one that stops it signing itself out (owner ask,
# 2026-09-07: "it's annoying we get signed out all the time").
#
# The volume login `agent-login` writes is a PAIR: an access token good for
# about eight hours and a refresh token. Every chat container shares one copy,
# so at each expiry whichever chat runs next refreshes it, Anthropic issues a
# NEW refresh token and kills the old one, and anything still holding the old
# one is signed out — a burst of failed runs and alert emails at every expiry.
#
# `claude setup-token` mints a LONG-LIVED token instead. Nothing refreshes, so
# there is nothing to race over. It is a value rather than a file, so it lives
# in the instance env file beside every other secret, base64-encoded for the
# reason the console's operator accounts are: docker compose interpolates `$`
# inside an env_file, and a token's alphabet is not ours to promise.
#
# This is the one place OPNinfer asks for a credential to be pasted, and it is
# deliberately HERE and not in the admin panel: the host's own tooling, on a
# root-only file, never through a browser or the app. The rule the admin card
# follows — no paste-your-token field — is unchanged.
agent_token() {
  local inst="${1:-}"
  [ -n "$inst" ] || die "Usage: ./deploy.sh agent-token <instance>"
  local env_file="instances/$inst.env"
  [ -f "$env_file" ] || die "No such instance: $inst (see instances/)"
  $DKR image inspect opninfer-agent >/dev/null 2>&1 || die "The agent image isn't built yet — run ./deploy.sh first."

  bold "Sandbox long-lived token — $inst"
  echo "Claude Code will run its own login flow in a moment. In it:"
  echo "  1. open the URL it prints, approve, and paste the code back;"
  echo "  2. it then prints a token starting sk-ant- — copy that;"
  echo "  3. press Ctrl-C if it doesn't exit on its own, and paste it below."
  echo
  # Its own credential volume, exactly like agent-login: the flow may write
  # session state, and it must be THIS instance's.
  $DKR run -it --rm -v "opninfer-agent-config-$inst:/home/sandbox/.claude"     opninfer-agent claude setup-token || true

  # ASK AGAIN rather than give up (2026-09-07, first real use: a paste that
  # did not land killed the command). The CLI says "you won't be able to see
  # it again", so the token above is already unrecoverable — dying here means
  # minting a fresh one for nothing. Three tries, each saying what was wrong.
  local token="" why="" tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    printf 'Paste the token (input hidden): '
    # -s so it never reaches the terminal scrollback; the shape checks below
    # are what confirm the paste, not the operator reading it back.
    token=""
    read -r -s token || true
    echo
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    why=""
    if [ -z "$token" ]; then
      why="Nothing was pasted."
    else
      case "$token" in
        sk-ant-api*) why="That is an organisation API key, not a plan token — those belong in Admin → API." ;;
        sk-ant-*)
          # The same rule the app applies, so a value accepted here is one
          # the app can use.
          case "$token" in
            *[!A-Za-z0-9_-]*) why="That has characters a Claude token never contains — the paste was probably cut short or wrapped." ;;
          esac
          ;;
        *) why="That doesn't start with sk-ant-, so it isn't the token (the terminal may have swallowed the paste)." ;;
      esac
    fi
    [ -n "$why" ] || break
    warn "$why"
    if [ "$tries" -lt 3 ]; then
      echo "  Try again — the token is the long sk-ant-oat01-… line printed above."
    fi
  done
  [ -z "$why" ] || die "Still no usable token after $tries tries — nothing changed. Re-run this command to mint another."

  local encoded
  encoded="$(printf '%s' "$token" | base64 -w0 2>/dev/null || printf '%s' "$token" | base64 | tr -d '\n')"
  grep -vE '^AGENT_OAUTH_TOKEN(_B64)?=' "$env_file" > "$env_file.tmp" 2>/dev/null || true
  {
    echo
    echo "# Sandbox: a long-lived Claude token (./deploy.sh agent-token $inst)."
    echo "# Base64 — compose would eat a \$ in an env_file. Remove this line to"
    echo "# go back to the refreshing sign-in in the agent credential volume."
    printf 'AGENT_OAUTH_TOKEN_B64="%s"\n' "$encoded"
  } >> "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
  chmod 600 "$env_file"
  ok "Token stored in $env_file (${#token} characters)."

  # Apply it now: the app reads its environment at START, so nothing changes
  # until that container is recreated. Drain first — a live reply would
  # otherwise be cut off mid-sentence for a change nobody was waiting on.
  local port
  port="$(grep -E '^APP_PORT=' "$env_file" 2>/dev/null | head -1 | sed -E 's/^APP_PORT="?([0-9]+)"?.*$/\1/' || true)"
  case "$port" in ''|*[!0-9]*) port="" ;; esac
  if [ -z "$port" ] || ! $DKR image inspect opninfer-app >/dev/null 2>&1; then
    echo "  It will be applied the next time you run ./deploy.sh"
    return 0
  fi

  drain_instance "$inst" "$env_file" "$port" || true
  info "Restarting '$inst' so it picks that up…"
  if INSTANCE_ENV="$env_file" dc -p "opninfer-$inst" --env-file "$env_file"       -f docker-compose.yml up -d --no-build --force-recreate app 2>/dev/null; then
    undrain_instance "$inst" "$env_file" "$port" || true
    # ASK THE APP, don't inspect the plumbing. Writing the file proves
    # nothing (compose can mangle it on the way in) and reading it back out
    # of the container proves little more (the running image may predate the
    # code that understands it) — both of those checks passed while the
    # console was still refusing to sign anyone in. This one is the app's own
    # answer about the credential it will actually use.
    local url="http://127.0.0.1:$port/api/admin/agent-credential"
    local dtoken body i
    dtoken="$(grep -E '^OPNINFER_DEPLOY_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d'"' -f2 || true)"
    if [ -z "$dtoken" ]; then
      warn "No deploy token on this instance, so the change can't be confirmed here."
      warn "Check Admin → Sandbox: it should say 'Long-lived token'."
      return 0
    fi
    body=""
    for i in 1 2 3 4 5 6 7 8 9 10; do
      body="$(curl -s --max-time 8 -H "Authorization: Bearer $dtoken" "$url" 2>/dev/null || true)"
      [ -z "$body" ] || break
      sleep 2
    done
    case "$body" in
      *'"source":"token"'*)
        ok "'$inst' is now using the long-lived token — no more eight-hourly sign-outs."
        # The one thing a token alone cannot do. Said HERE because this is
        # the moment it matters, and the effect is silent otherwise: the
        # panel simply stops gaining numbers and the warning email stops.
        if ! $DKR run --rm -v "opninfer-agent-config-$inst:/home/sandbox/.claude"             opninfer-agent sh -c 'grep -q claudeAiOauth /home/sandbox/.claude/.credentials.json 2>/dev/null' 2>/dev/null; then
          echo
          info "Plan usage figures are not tracked on a token — Admin → Sandbox says so."
          echo "  Claude limits long-lived tokens to running work, so the plan's usage"
          echo "  screen can't be read on one. Runs are unaffected, and you are still"
          echo "  alerted if the plan refuses one; what you lose is the 90% warning."
        fi
        ;;
      *'"source":"malformed"'*)
        warn "The token reached '$inst' but arrived unreadable — it is still using the"
        warn "container sign-in. Run this again and re-paste the token."
        ;;
      *'"source":"none"'*)
        warn "'$inst' still sees no token. Its app is probably an OLDER BUILD that"
        warn "doesn't read one yet — run  ./deploy.sh  and then check Admin → Sandbox."
        ;;
      "")
        warn "'$inst' restarted but isn't answering on :$port yet."
        warn "Give it a moment, then check Admin → Sandbox."
        ;;
      *)
        warn "Couldn't confirm the change on '$inst' — check Admin → Sandbox."
        ;;
    esac
  else
    undrain_instance "$inst" "$env_file" "$port" || true
    warn "Could not restart '$inst' — run ./deploy.sh to apply it."
  fi
}
# `./deploy.sh agent-logout <instance>` — take an instance OFF the Claude
# plan entirely, so its Sandbox runs on the organisation API key alone.
#
# Both halves, because there are two: the long-lived token in the env file
# AND the sign-in inside the credential volume. Leaving either behind means
# the instance is still quietly drawing on someone's plan.
#
# The volume itself is NOT deleted: connected services (Figma and friends)
# keep their own OAuth in the same file, and they are set up per instance at
# some cost. `claude auth logout` removes the Anthropic sign-in and leaves
# those alone.
#
# The last step is not scriptable and the command says so: which credential
# a Sandbox uses is a setting in that portal's own admin area, and a portal
# still set to "Claude subscription" with nothing to sign in as will fail
# its runs rather than quietly switching.
agent_logout() {
  local inst="${1:-}"
  [ -n "$inst" ] || die "Usage: ./deploy.sh agent-logout <instance>"
  local env_file="instances/$inst.env"
  [ -f "$env_file" ] || die "No such instance: $inst (see instances/)"

  local had_token="no"
  if grep -qE '^AGENT_OAUTH_TOKEN(_B64)?=' "$env_file" 2>/dev/null; then
    had_token="yes"
    grep -vE '^AGENT_OAUTH_TOKEN(_B64)?=' "$env_file" > "$env_file.tmp" 2>/dev/null || true
    mv "$env_file.tmp" "$env_file"
    chmod 600 "$env_file"
    ok "Removed the long-lived token from $env_file"
  else
    info "No long-lived token was set for '$inst'."
  fi

  if $DKR image inspect opninfer-agent >/dev/null 2>&1 &&      $DKR volume inspect "opninfer-agent-config-$inst" >/dev/null 2>&1; then
    info "Signing the '$inst' credential volume out of its Claude account…"
    # Best-effort: an already-signed-out volume exits non-zero and that is
    # not a failure of this command.
    $DKR run --rm -v "opninfer-agent-config-$inst:/home/sandbox/.claude"       opninfer-agent claude auth logout >/dev/null 2>&1 || true
    $DKR run --rm -v "opninfer-agent-config-$inst:/home/sandbox/.claude"       opninfer-agent sh -c 'rm -f /home/sandbox/.claude/.credentials.json.bak' >/dev/null 2>&1 || true
    # Say what is actually left, rather than assuming the logout worked.
    local left
    left="$($DKR run --rm -v "opninfer-agent-config-$inst:/home/sandbox/.claude"       opninfer-agent sh -c 'grep -c claudeAiOauth /home/sandbox/.claude/.credentials.json 2>/dev/null || echo 0' 2>/dev/null || echo "?")"
    case "$left" in
      0) ok "The credential volume no longer holds a Claude sign-in." ;;
      ?) warn "Could not read the credential volume — check it by hand if this instance must not use a plan." ;;
      *) warn "A Claude sign-in is STILL in the volume. Remove it with:"
         warn "  $DKR run --rm -v opninfer-agent-config-$inst:/home/sandbox/.claude opninfer-agent sh -c 'rm -f ~/.claude/.credentials.json'" ;;
    esac
    echo "  Connected services (MCP) were left alone — check with: ./deploy.sh agent-mcp $inst list"
  else
    info "No credential volume for '$inst' — nothing to sign out."
  fi

  # Only restart if the env file actually changed; a portal is not worth
  # bouncing to apply nothing.
  local port
  port="$(grep -E '^APP_PORT=' "$env_file" 2>/dev/null | head -1 | sed -E 's/^APP_PORT="?([0-9]+)"?.*$/\1/' || true)"
  case "$port" in ''|*[!0-9]*) port="" ;; esac
  if [ "$had_token" = "yes" ] && [ -n "$port" ] && $DKR image inspect opninfer-app >/dev/null 2>&1; then
    drain_instance "$inst" "$env_file" "$port" || true
    info "Restarting '$inst'…"
    if INSTANCE_ENV="$env_file" dc -p "opninfer-$inst" --env-file "$env_file"         -f docker-compose.yml up -d --no-build --force-recreate app 2>/dev/null; then
      undrain_instance "$inst" "$env_file" "$port" || true
      local dtoken body
      dtoken="$(grep -E '^OPNINFER_DEPLOY_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d'"' -f2 || true)"
      if [ -n "$dtoken" ]; then
        # Retry: a recreated app takes a few seconds to answer, and a single
        # early curl reported "no answer" on the first real use (2026-09-07)
        # for an instance that was in fact perfectly fine.
        local i
        body=""
        for i in 1 2 3 4 5 6 7 8 9 10; do
          body="$(curl -s --max-time 8 -H "Authorization: Bearer $dtoken"             "http://127.0.0.1:$port/api/admin/agent-credential" 2>/dev/null || true)"
          [ -z "$body" ] || break
          sleep 2
        done
        case "$body" in
          *'"source":"none"'*) ok "'$inst' is no longer configured with a plan token." ;;
          "") warn "'$inst' restarted but is not answering on :$port yet — check Admin → Sandbox." ;;
          *) warn "'$inst' restarted but still reports: $body" ;;
        esac
      fi
    else
      undrain_instance "$inst" "$env_file" "$port" || true
      warn "Could not restart '$inst' — run ./deploy.sh to apply it."
    fi
  fi

  bold "One step left, and it is not scriptable:"
  echo "  Open that portal's Admin → Sandbox and set the credential to"
  echo "  'Organisation API key', choosing a stored Anthropic key."
  echo "  Left on 'Claude subscription' with no sign-in, its runs will fail."
}
if [ "${1:-}" = "agent-logout" ]; then
  shift
  agent_logout "$@"
  exit $?
fi

if [ "${1:-}" = "agent-token" ]; then
  shift
  agent_token "$@"
  exit $?
fi

# `./deploy.sh agent-login <instance>` — sign the instance's Sandbox in to a
# Claude account through Anthropic's OWN login flow (this script never sees
# the credential). The sign-in lands in that instance's agent credential
# volume, which every agent container mounts and which survives updates.
#
# NO LONGER SUPPORTED (2026-09-07, owner decision) — kept, not deleted.
#
# What is wrong with it is not a bug we can fix here. The credential it
# writes is a PAIR: an access token good for about eight hours and a refresh
# token. Every chat container shares one copy of that file, so at each expiry
# whichever chat runs next refreshes it, Anthropic issues a new refresh token
# and kills the old one, and any container still holding the old one is
# signed out. On one instance that was a burst of failed runs and alert emails every
# eight hours — 24 errors in one day — and it recurred for as long as this
# was the credential. `agent-token` has nothing to refresh and therefore
# nothing to race over.
#
# It stays because it is still the ONLY way to do two things: mint a token in
# the first place (`agent-token` runs Claude Code's own login flow through
# it), and read the plan's usage figures, which a long-lived token cannot do
# (see planUsageViaVolumeEnabled in src/lib/agent/limits-store.ts). It works
# exactly as it always did; it just should not be an instance's credential.
if [ "${1:-}" = "agent-login" ]; then
  login_name="${2:-}"
  [ -n "$login_name" ] || die "Usage: ./deploy.sh agent-login <instance>"
  [ -f "instances/$login_name.env" ] || die "No such instance: $login_name (see instances/)"
  $DKR image inspect opninfer-agent >/dev/null 2>&1 || die "The agent image isn't built yet — run ./deploy.sh first."
  warn "agent-login is no longer the supported way to put an instance on a plan."
  echo "  The sign-in it creates is shared by every chat and refreshes itself about"
  echo "  every eight hours, and the chats race each other to do it — which signs the"
  echo "  losers out. Use instead:   ./deploy.sh agent-token $login_name"
  echo
  echo "  Carry on only if you want this volume signed in for plan-usage readings,"
  echo "  or to mint a token from. Ctrl-C to stop."
  echo
  info "Signing the '$login_name' Sandbox in to a Claude account…"
  echo "  In the prompt that follows: choose 'Claude account', open the URL it prints in a"
  echo "  browser, approve, paste the code back here, then type /exit. The login persists."
  $DKR run -it --rm -v "opninfer-agent-config-$login_name:/home/sandbox/.claude" opninfer-agent claude
  exit $?
fi

# --- operator console -------------------------------------------------------
# One read-only overview across every portal on this host, served from the
# SAME app image with OPNINFER_MODE=console (docker-compose.console.yml).
# It has no database: it reads each portal's Postgres as a `console_ro` role
# created below with SELECT and nothing else, and its own accounts live in
# instances/console/console.env.

# NOT `instances/*.env`. deploy.sh treats every file matching that glob as a
# PORTAL — it picks the first one as the env file for the image build, loops
# over them to deploy, and scans them for free ports. Putting the console's
# two files there made `console-portals.env` sort alphabetically first, so the
# build ran with an env file that has no SANDBOX_BROKER_TOKEN and died with
# "required variable ... is missing a value" — on the SECOND deploy, once the
# files existed, which is exactly the sort of delayed breakage that is worst
# to diagnose. A subdirectory keeps them beside the portal secrets (and inside
# the same git-ignored tree) while staying invisible to that glob.
CONSOLE_DIR="instances/console"
CONSOLE_ENV="$CONSOLE_DIR/console.env"
CONSOLE_PORTALS_ENV="$CONSOLE_DIR/portals.env"

# Move an older layout's files into place. Must run BEFORE anything globs
# `instances/*.env` — by the time deploy_console runs, the build has already
# failed on them.
# The layout this replaces. Named as literals, NOT built from $CONSOLE_DIR —
# they are the OLD paths and must not follow it when it changes again.
LEGACY_CONSOLE_ENV="instances/console.env"
LEGACY_CONSOLE_PORTALS_ENV="instances/console-portals.env"
migrate_console_env() {
  [ -f "$LEGACY_CONSOLE_ENV" ] || [ -f "$LEGACY_CONSOLE_PORTALS_ENV" ] || return 0
  mkdir -p "$CONSOLE_DIR"
  chmod 700 "$CONSOLE_DIR" 2>/dev/null || true
  [ ! -f "$LEGACY_CONSOLE_ENV" ] || mv -f "$LEGACY_CONSOLE_ENV" "$CONSOLE_ENV"
  [ ! -f "$LEGACY_CONSOLE_PORTALS_ENV" ] || mv -f "$LEGACY_CONSOLE_PORTALS_ENV" "$CONSOLE_PORTALS_ENV"
  info "Moved the console's config to $CONSOLE_DIR/ (it must not look like a portal)."
}

# Read one KEY="value" (or KEY=value) out of an env file. Never fatal: under
# `set -euo pipefail` a grep that matches nothing would otherwise end the
# deploy — the "script simply vanished" class this file has been bitten by
# twice already.
env_get() {
  grep -E "^$2=" "$1" 2>/dev/null | head -1 | sed -E "s/^$2=\"?([^\"]*)\"?.*$/\1/" || true
}

# `acme` -> `ACME`, `ini-tech` -> `INI_TECH`. Must match `envSuffix` in
# src/lib/console/instances.ts, or the console sees no portals at all
# (asserted by instances.test.ts).
env_suffix() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_' | sed 's/_*$//'
}

# The console's own secrets + accounts. Written ONCE and never regenerated —
# rewriting it would sign the operator out and, worse, silently replace their
# password with nothing.
ensure_console_env() {
  migrate_console_env
  [ ! -f "$CONSOLE_ENV" ] || return 0
  umask 077
  mkdir -p "$CONSOLE_DIR"
  cat > "$CONSOLE_ENV" <<EOF
# OPNinfer OPERATOR CONSOLE — generated by deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Git-ignored. A read-only overview across every portal on this host.
#
# Accounts live here, not in a database (there isn't one). Add or change one:
#     ./deploy.sh console-password
CONSOLE_PORT="3000"
AUTH_SECRET="$(gen_secret)"

# Password for the read-only \`console_ro\` role deploy.sh creates in every
# portal's database. Rotating it means dropping that role in each database.
CONSOLE_DB_PASSWORD="$(gen_token)"

# Console accounts: base64 of "email:argon2hash;email:argon2hash".
# Written by ./deploy.sh console-password — do not hand-edit.
#
# BASE64 because docker compose INTERPOLATES a \$ in an env_file, and an
# argon2 hash is full of them: \$argon2id\$v=19\$m=... reached the container
# as =19=19456 with the algorithm name gone, and the console reported "no
# operator accounts are configured" (found live, 2026-09-07).
CONSOLE_OPERATORS_B64=""

# Set this to the console's public https address if you put it behind your
# reverse proxy. Leaving it unset serves plain http on CONSOLE_PORT, which is
# what you want while reaching it over the LAN.
# AUTH_URL="https://console.example.com"
EOF
  chmod 600 "$CONSOLE_ENV"
  ok "Created $CONSOLE_ENV"
}

# Attach the console to each portal's compose network so it can reach that
# project's database container. Compose can't express this: the network list
# depends on which instances exist on this host, which it learns at run time.
#
# The network is found by compose's OWN label first and only falls back to the
# derived name, and the attachment is VERIFIED afterwards — a silent failure
# here would surface as "every portal unreachable" on the console with nothing
# in any log to explain it.
connect_console_networks() {
  local container="opninfer-console-app-1" name net attached
  for name in $CONSOLE_NAMES; do
    net="$($DKR network ls       --filter "label=com.docker.compose.project=opninfer-$name"       --filter "name=opninfer-${name}_default"       --format '{{.Name}}' 2>/dev/null | head -1 || true)"
    [ -n "$net" ] || net="opninfer-${name}_default"
    # Already-connected is an error we expect on every re-run — swallow it.
    $DKR network connect "$net" "$container" >/dev/null 2>&1 || true
    attached="$($DKR inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'       "$container" 2>/dev/null || true)"
    case " $attached " in
      *" $net "*) ;;
      *) warn "  console: could not attach to '$net' — '$name' will read as unreachable" ;;
    esac
  done
}

# Hash a password the same way the portals do (argon2id), inside the app image
# so there is nothing extra to install on the host. The password goes in on
# STDIN, never in argv, where `ps` would show it to every user on the box.
console_hash() {
  $DKR run --rm -i opninfer-app node -e '
    const { hash } = require("@node-rs/argon2");
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      hash(s.replace(/\r?\n$/, ""), { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 })
        .then((h) => process.stdout.write(h))
        .catch((e) => { console.error(e); process.exit(1); });
    });
  '
}

console_password() {
  $DKR image inspect opninfer-app >/dev/null 2>&1 || die "The app image isn't built yet — run ./deploy.sh first."
  ensure_console_env
  local email pass pass2 hash existing suffix
  read -rp "Console sign-in email: " email
  [ -n "$email" ] || die "An email is required."
  case "$email" in *@*) ;; *) die "That doesn't look like an email address." ;; esac
  read -rsp "Password: " pass; echo
  read -rsp "Again:    " pass2; echo
  [ -n "$pass" ] || die "A password is required."
  [ "$pass" = "$pass2" ] || die "The two passwords don't match."
  case "$pass" in ????????*) ;; *) die "Use at least 8 characters." ;; esac

  info "Hashing…"
  hash="$(printf '%s' "$pass" | console_hash)" || die "Could not hash the password."
  [ -n "$hash" ] || die "Could not hash the password."

  # Replace this address if it is already listed, keeping everyone else. Read
  # the base64 form, falling back to the plain one an older layout wrote.
  existing="$(env_get "$CONSOLE_ENV" CONSOLE_OPERATORS_B64)"
  if [ -n "$existing" ]; then
    existing="$(printf '%s' "$existing" | base64 -d 2>/dev/null || true)"
  else
    existing="$(env_get "$CONSOLE_ENV" CONSOLE_OPERATORS)"
  fi
  local kept="" entry
  local IFS=';'
  for entry in $existing; do
    case "$entry" in
      ""|"${email}:"*) ;;
      # Keep other people — but only if their hash is intact. One mangled by
      # compose's interpolation can never verify, and carrying it forward
      # would leave a dead account in the list for ever.
      *'$argon2'*) kept="${kept:+$kept;}$entry" ;;
      *) ;;
    esac
  done
  unset IFS
  local line="${kept:+$kept;}${email}:${hash}"
  local encoded
  encoded="$(printf '%s' "$line" | base64 -w0 2>/dev/null || printf '%s' "$line" | base64 | tr -d '\n')"
  # Rewrite just that line, dropping any plain-form leftover (which compose
  # would have corrupted anyway).
  grep -vE '^CONSOLE_OPERATORS(_B64)?=' "$CONSOLE_ENV" > "$CONSOLE_ENV.tmp" 2>/dev/null || true
  printf 'CONSOLE_OPERATORS_B64="%s"\n' "$encoded" >> "$CONSOLE_ENV.tmp"
  mv "$CONSOLE_ENV.tmp" "$CONSOLE_ENV"
  chmod 600 "$CONSOLE_ENV"
  ok "Console sign-in set for $email."

  # Apply it now. The container reads its accounts from the env file at
  # START, so a new account does nothing until it is recreated — and telling
  # someone to "redeploy" for that means rebuilding four portals to pick up a
  # one-line change. Recreating just the console takes a second and needs no
  # build. Best-effort: if it is not running yet, the next ./deploy.sh brings
  # it up with the account already in place.
  if [ -f "$CONSOLE_PORTALS_ENV" ] && $DKR image inspect opninfer-app >/dev/null 2>&1; then
    info "Restarting the console so it picks that up…"
    if dc -p opninfer-console --env-file "$CONSOLE_ENV" -f docker-compose.console.yml          up -d --no-build --force-recreate 2>/dev/null; then
      # Recreating drops the extra network attachments with the container.
      CONSOLE_NAMES="$(env_get "$CONSOLE_PORTALS_ENV" CONSOLE_INSTANCES)"
      connect_console_networks || true
      # ASK THE CONSOLE, don't inspect the plumbing.
      #
      # Twice now a check here confirmed the wrong layer. First the account
      # was written correctly and compose ate the `$`s on the way in. Then the
      # value arrived intact — and the check passed — but the RUNNING IMAGE
      # predated the code that reads it, so the screen still said "no operator
      # accounts are configured". The env arriving is not the same as the app
      # understanding it. Its own sign-in page knows the difference.
      local port body i
      port="$(env_get "$CONSOLE_ENV" CONSOLE_PORT)"
      case "$port" in ''|*[!0-9]*) port=3000 ;; esac
      body=""
      for i in 1 2 3 4 5 6 7 8 9 10; do
        body="$(curl -s --max-time 8 "http://127.0.0.1:$port/login" 2>/dev/null || true)"
        [ -z "$body" ] || break
        sleep 2
      done
      case "$body" in
        *"No operator accounts are configured"*)
          warn "The console is running an OLDER BUILD that cannot read this account."
          warn "Run  ./deploy.sh  to rebuild it, then sign in."
          ;;
        *'name="email"'*)
          ok "Console ready — sign in at http://<this-host>:$port as $email"
          ;;
        "")
          warn "The console restarted but is not answering on :$port yet."
          warn "Give it a moment, then: $DKR compose -p opninfer-console logs app"
          ;;
        *)
          warn "The console restarted but its sign-in page looks wrong — run ./deploy.sh."
          ;;
      esac
    else
      warn "Could not restart the console — run ./deploy.sh to apply it."
    fi
  else
    echo "  It will be applied the next time you run ./deploy.sh"
  fi
}

if [ "${1:-}" = "console-password" ]; then
  console_password
  exit $?
fi

# An unrecognised argument must NOT fall through to a full deploy. Every
# subcommand above exits on its own, so anything still here that isn't "add"
# is a typo — and `./deploy.sh console-passwrod` silently rebuilding and
# recreating four client portals is not what anyone meant by it (2026-09-07:
# `./deploy.sh randompass` did exactly that).
case "${1:-}" in
  ""|add) ;;
  *)
    echo "Unknown command: $1" >&2
    echo >&2
    echo "  ./deploy.sh                       update every instance" >&2
    echo "  ./deploy.sh add                   add an instance" >&2
    echo "  ./deploy.sh console-password      set the operator console sign-in" >&2
    echo "  ./deploy.sh agent-login <name>    legacy sign-in (signs itself out — prefer agent-token)" >&2
    echo "  ./deploy.sh agent-token <name>    use a long-lived token instead (no sign-outs)" >&2
    echo "  ./deploy.sh agent-logout <name>   take an instance off the Claude plan" >&2
    echo "  ./deploy.sh agent-mcp <name> …    connected services for a Sandbox" >&2
    exit 2
    ;;
esac

if [ "${1:-}" = "add" ]; then
  wizard
elif ! ls instances/*.env >/dev/null 2>&1; then
  wizard
  ls instances/*.env >/dev/null 2>&1 || die "No instances configured — nothing to deploy."
fi

# Shared-engine tunables (safe defaults; edit and re-run to change).
if [ ! -f engines.env ]; then
  umask 077
  cat > engines.env <<'EOF'
# Shared engine settings for ALL instances — generated by deploy.sh, git-ignored.
# Whisper model size (tiny/base/small/medium/large-v3). Bigger = better + more RAM.
WHISPER_MODEL="small"
# GPU host? Swap the TTS image (and uncomment the device stanza in
# docker-compose.engines.yml) for ~35x realtime speech:
# TTS_IMAGE="ghcr.io/remsky/kokoro-fastapi-gpu:latest"
EOF
  ok "Wrote engines.env (shared engine settings)."
fi

# --- pull latest code -------------------------------------------------------
# NB: this script updates ITSELF. Bash reads a script incrementally and keeps a
# byte offset into the file, so a pull that changes deploy.sh mid-run can make
# it resume at the wrong place and execute garbage. When the pull actually
# changes this file, re-exec so the rest of the run uses ONE consistent
# version. OPNINFER_REEXEC stops that becoming a loop.
if [ -d .git ] && [ "${OPNINFER_REEXEC:-}" != "1" ]; then
  info "Pulling the latest version from GitHub…"
  BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if git pull --ff-only; then
    ok "Up to date with origin."
    AFTER="$(git rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$BEFORE" != "$AFTER" ] && ! git diff --quiet "$BEFORE" "$AFTER" -- deploy.sh 2>/dev/null; then
      info "deploy.sh itself was updated — restarting with the new version…"
      export OPNINFER_REEXEC=1
      export OPNINFER_NEW_INSTANCES="$NEW_INSTANCES"
      # `add` has already created its instance (carried in OPNINFER_NEW_INSTANCES);
      # replaying it would re-enter the wizard for a second one (audit 2026-09-05).
      case "${1:-}" in
        add) exec "$0" ;;
        *) exec "$0" "$@" ;;
      esac
    fi
  else
    warn "git pull failed. Is this machine authenticated to the private repo?"
    warn "Set up an SSH deploy key or 'gh auth login' (README → Deploy). Continuing with the current checkout."
  fi
elif [ ! -d .git ]; then
  warn "Not a git checkout — can't self-update. Clone the repo with git to enable './deploy.sh' updates."
fi

# --- build images ONCE (all instances share them) ---------------------------
# Before any `instances/*.env` glob: an older layout left the console's files
# in there, where the build would pick one up as a portal (see CONSOLE_DIR).
migrate_console_env || true
FIRST_ENV="$(ls instances/*.env | head -1)"

info "Building the sandbox toolchain image (first run takes a few minutes)…"
$DKR build -t opninfer-sandbox docker/sandbox

# The Sandbox agent image: Claude Code pinned to the version the app's Agent
# SDK expects, on top of the toolchain above (src/lib/agent/version-pin.test.ts
# keeps the two in step). Built AFTER the toolchain — it is FROM it.
info "Building the Sandbox agent image…"
$DKR build -t opninfer-agent docker/agent

info "Building the app/worker/migrator/broker images…"
# No provenance/SBOM attestations: they cost build and export time on every
# image and nothing here consumes them (these images are built on the host that
# runs them and never leave it).
BUILDX_NO_DEFAULT_ATTESTATIONS=1   dc --env-file "$FIRST_ENV" -f docker-compose.yml build

# --- shared engines ---------------------------------------------------------
info "Starting the shared engines (Gotenberg · Docling OCR · Whisper STT · Kokoro TTS)…"
dc --env-file engines.env -f docker-compose.engines.yml up -d --remove-orphans

# --- health checks ----------------------------------------------------------
# "The containers started" is NOT "it works": the ingestion worker once sat
# unable to reach its own database for eight days while every container showed
# Up and deploy.sh said "complete". These checks prove each moving part is
# actually doing its job, and say so plainly when one isn't.
FAILURES=""
note_failure() { FAILURES="$FAILURES  ✗ $1\n"; warn "$1"; }

# Ask a RUNNING instance to stop taking new work, then wait for the replies
# already in flight to finish before we replace the container. Without this an
# update kills every live reply mid-sentence — the turn registry is in memory,
# so whatever was generating dies with the process.
#
# Best-effort by design: an instance that isn't running yet, predates the drain
# endpoint, or has no OPNINFER_DEPLOY_TOKEN simply deploys the old way. A
# missing drain must never block a deploy.

# Instances created before draining existed have no token. Mint one so the
# NEXT update can drain them (this one still can't — the running container
# hasn't got the variable yet).
ensure_deploy_token() {
  local env_file="$1"
  if grep -qE '^OPNINFER_DEPLOY_TOKEN=' "$env_file" 2>/dev/null; then return 0; fi
  {
    echo ""
    echo "# Added by deploy.sh: lets an update wait for in-flight replies to"
    echo "# finish before the container is replaced (POST /api/admin/drain)."
    echo "OPNINFER_DEPLOY_TOKEN=\"$(gen_token)\""
  } >> "$env_file"
  info "  added OPNINFER_DEPLOY_TOKEN to $env_file (drains from the next update on)"
}

# Back-fill the per-portal sandbox identity on instances created before it
# existed. Without it every instance shares one label, one container-name space
# and one egress network on the shared Docker daemon — so each instance's idle
# reaper force-removes the others' RUNNING sandboxes, and different clients'
# sandboxes sit on the same network segment. Same failure-tolerance rules as
# ensure_deploy_token: this may never abort a deploy.
ensure_instance_identity() {
  local env_file="$1" name="$2"
  if grep -qE '^OPNINFER_INSTANCE=' "$env_file" 2>/dev/null; then return 0; fi
  if {
    echo ""
    echo "# Added by deploy.sh: names this portal's sandbox containers, labels"
    echo "# and egress network apart from the other instances on this host."
    echo "OPNINFER_INSTANCE=\"$name\""
  } >> "$env_file" 2>/dev/null; then
    info "  added OPNINFER_INSTANCE to $env_file (sandbox isolation between instances)"
  else
    # Never fatal: the instance still runs, its sandboxes just stay in the
    # shared namespace they were already in.
    warn "  could not write OPNINFER_INSTANCE to $env_file — add it by hand"
  fi
  return 0
}

check_instance() {
  local name="$1" env_file="$2" port="$3"

  # 1. Migrations applied cleanly (one-shot container must have exited 0).
  local migrate_exit
  migrate_exit="$($DKR inspect -f '{{.State.ExitCode}}' \
    "$(dc -p "opninfer-$name" --env-file "$env_file" -f docker-compose.yml ps -aq migrate 2>/dev/null)" 2>/dev/null || echo "?")"
  if [ "$migrate_exit" = "0" ]; then
    ok "  migrations applied"
  else
    note_failure "$name: migrations did not complete (exit $migrate_exit) — see 'logs migrate'"
  fi

  # 2. The app answers HTTP. Give it up to 60s: a cold start after an image
  #    rebuild is slower than compose's "up" returning.
  #
  #    ANY 2xx/3xx counts as alive. Don't demand a literal 200: this instance's
  #    AUTH_URL is its public https domain, so a plain-HTTP request to the
  #    loopback address is legitimately answered with a 307 to the canonical
  #    URL. That redirect only exists because Next booted and the middleware
  #    ran — which is precisely what we're testing for.
  local code="" i
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/login" || echo 000)"
    case "$code" in 2??|3??) break ;; esac
    sleep 2
  done
  case "$code" in
    2??|3??) ok "  app responding on :$port (HTTP $code)" ;;
    *) note_failure "$name: the app did not answer on :$port (last status $code) — see 'logs app'" ;;
  esac

  # 3. The ingestion worker reached the database. This is the exact failure
  #    that hid for eight days — a connect error only ever appeared as a log
  #    line nobody was reading.
  #    Retried, and a non-answer at the end counts as a FAILURE. The worker logs
  #    on its first connect, a second or two after `up` returns, so the single
  #    immediate check reported "no verdict yet" on a perfectly healthy deploy
  #    (it did on 2026-08-23) — which reads exactly like the outage this check
  #    exists to catch. A warning nobody can act on is worse than either answer.
  local wlog verdict="" waited=0
  while [ "$waited" -lt 30 ]; do
    # The container's own healthcheck first (a marker file the loop writes on
    # connect and removes on a loop error — audit 2026-09-05): the log grep
    # below misreads a long-running, unchanged worker, whose "connected" line
    # scrolled out of the tail long ago while a stale "loop error" from days
    # back may still be in it. The grep stays as the fallback for a container
    # built before the healthcheck existed.
    whealth="$($DKR inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "opninfer-$name-worker-1" 2>/dev/null || true)"
    if [ "$whealth" = "healthy" ]; then
      verdict="ok"
      break
    fi
    if [ "$whealth" = "unhealthy" ]; then
      verdict="error"
      break
    fi
    wlog="$(dc -p "opninfer-$name" --env-file "$env_file" -f docker-compose.yml \
      logs --tail=200 worker 2>/dev/null || true)"
    if [ -z "$whealth" ] && printf '%s' "$wlog" | grep -q "connected to database"; then
      verdict="ok"
      break
    fi
    if [ -z "$whealth" ] && printf '%s' "$wlog" | grep -q "loop error"; then
      verdict="error"
      break
    fi
    sleep 3
    waited=$((waited + 3))
  done
  case "$verdict" in
    ok) ok "  ingestion worker connected" ;;
    error) note_failure "$name: the ingestion worker cannot reach the database — uploaded files will never be processed. Run: $DKR compose -p opninfer-$name --env-file $env_file logs worker" ;;
    *) note_failure "$name: the ingestion worker never reported a database connection within 30s — uploads may never be processed. Run: $DKR compose -p opninfer-$name --env-file $env_file logs worker" ;;
  esac

  # 4. The sandbox broker is listening, and it is the agent-tier broker (its
  #    boot line names the agent image) — a stale pre-v0.4 broker would print
  #    "listening on" too, and the Sandbox would then fail on every run.
  sbx_log="$(dc -p "opninfer-$name" --env-file "$env_file" -f docker-compose.yml \
      logs --tail=50 sandboxd 2>/dev/null || true)"
  if printf '%s' "$sbx_log" | grep -q "listening on"; then
    if printf '%s' "$sbx_log" | grep -q "agent=opninfer-agent"; then
      ok "  sandbox broker ready (agent tier)"
    else
      note_failure "$name: the sandbox broker is up but is NOT the agent-tier build — the Sandbox will fail; rebuild with ./deploy.sh"
    fi
  else
    note_failure "$name: the sandbox broker isn't listening — the Sandbox will fail"
  fi
  # 5. The agent image exists on this host (the broker refuses any other).
  if $DKR image inspect opninfer-agent >/dev/null 2>&1; then
    ok "  agent image present"
  else
    note_failure "$name: the opninfer-agent image is missing — the Sandbox cannot start a container"
  fi
}

# Engines are shared, so they're probed once. The worker container has httpx
# and sits on the engines network, which is exactly the path that matters.
check_engines() {
  local first_env first_name
  first_env="$FIRST_ENV"
  first_name="$(basename "$first_env" .env)"
  local out
  out="$(dc -p "opninfer-$first_name" --env-file "$first_env" -f docker-compose.yml \
    exec -T worker python - <<'PY' 2>/dev/null || true
import httpx

# Each engine gets CANDIDATE paths, and passes if any of them answers 2xx/3xx.
#
# Two failure modes to tell apart. "Unreachable" (nothing accepted the
# connection) is a real outage. A 404 on one known path is not — these are
# third-party images and a version bump moves endpoints around, so pinning a
# single path would report a healthy engine as broken and train the operator to
# ignore the failure list. Anything that ANSWERS on a documented path is up;
# only a connection error, or an answer on none of them, is a failure.
for name, paths in (
    ("gotenberg", ("http://gotenberg:3000/health",)),
    ("docling", ("http://docling:5001/health",)),
    ("whisper", ("http://whisper:9000/docs",)),
    # Kokoro drives reply TTS and is the only engine on a floating :latest tag,
    # so it is the likeliest to come back broken after an image change — and it
    # was the one engine never probed at all.
    ("kokoro", ("http://kokoro:8880/health", "http://kokoro:8880/docs",
                "http://kokoro:8880/v1/audio/voices")),
):
    verdict = None
    for url in paths:
        try:
            r = httpx.get(url, timeout=10)
            if 200 <= r.status_code < 400:
                verdict = "ok"
                break
            verdict = str(r.status_code)
        except Exception as e:
            if verdict is None:
                verdict = f"unreachable ({type(e).__name__})"
    print(f"{name}={verdict}")
PY
)"
  if [ -z "$out" ]; then
    warn "  engines: could not probe (worker not ready) — re-run ./deploy.sh to re-check"
    return
  fi
  local line
  printf '%s\n' "$out" | while IFS= read -r line; do
    case "$line" in
      *=ok) ok "  engine ${line%%=*} reachable" ;;
      "") ;;
      *) warn "  engine $line" ;;
    esac
  done
  printf '%s' "$out" | grep -q "unreachable" && \
    note_failure "one or more shared engines are unreachable — document/audio conversion will degrade"
  return 0
}

# --- operator console: read-only roles, wiring, health ----------------------

# Create (or refresh) the SELECT-only `console_ro` role in one portal's
# database. Idempotent, and never fatal: a portal whose role could not be
# created is simply left out of the console's list rather than failing the
# whole deploy for a reporting feature.
#
# The default-privileges grant is the part that matters over time — without
# it, every future migration's tables would be invisible to the console until
# someone remembered to re-grant.
ensure_console_role() {
  local name="$1" env_file="$2" pw="$3"
  local user db container
  user="$(env_get "$env_file" POSTGRES_USER)"; user="${user:-opninfer}"
  db="$(env_get "$env_file" POSTGRES_DB)"; db="${db:-opninfer}"
  container="opninfer-$name-db-1"

  $DKR inspect "$container" >/dev/null 2>&1 || return 1
  $DKR exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" >/dev/null 2>&1 <<SQL || return 1
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'console_ro') THEN
    CREATE ROLE console_ro LOGIN;
  END IF;
END
\$\$;
ALTER ROLE console_ro WITH LOGIN PASSWORD '$pw';
GRANT CONNECT ON DATABASE "$db" TO console_ro;
GRANT USAGE ON SCHEMA public TO console_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO console_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO console_ro;
SQL
  return 0
}

# Rewrite the generated half of the console's config: which portals exist and
# how to reach them. Regenerated on EVERY deploy, so adding an instance needs
# no second step — the secrets and accounts live in the other file and are
# never touched here.
write_console_portals() {
  local pw="$1" names="" env_file name suffix user db domain
  umask 077
  {
    echo "# Generated by deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — DO NOT EDIT."
    echo "# Which portals the operator console reads, and how it reaches them."
    echo "# Rewritten on every deploy; secrets and accounts live in console.env."
    echo
  } > "$CONSOLE_PORTALS_ENV.tmp"

  for env_file in instances/*.env; do
    name="$(basename "$env_file" .env)"
    [ "$name" != "console" ] || continue
    if ! ensure_console_role "$name" "$env_file" "$pw"; then
      warn "  console: could not prepare a read-only role on '$name' — leaving it out"
      continue
    fi
    suffix="$(env_suffix "$name")"
    user="$(env_get "$env_file" POSTGRES_USER)"; user="${user:-opninfer}"
    db="$(env_get "$env_file" POSTGRES_DB)"; db="${db:-opninfer}"
    domain="$(env_get "$env_file" DOMAIN)"
    names="${names:+$names }$name"
    # By CONTAINER name, not the `db` service alias: every project has a `db`,
    # and this container is attached to all of their networks at once.
    printf 'CONSOLE_DB_%s="postgresql://console_ro:%s@opninfer-%s-db-1:5432/%s"\n' \
      "$suffix" "$pw" "$name" "$db" >> "$CONSOLE_PORTALS_ENV.tmp"
    printf 'CONSOLE_LABEL_%s="%s"\n' "$suffix" "${domain:-$name}" >> "$CONSOLE_PORTALS_ENV.tmp"
  done

  printf 'CONSOLE_INSTANCES="%s"\n' "$names" >> "$CONSOLE_PORTALS_ENV.tmp"
  mv "$CONSOLE_PORTALS_ENV.tmp" "$CONSOLE_PORTALS_ENV"
  chmod 600 "$CONSOLE_PORTALS_ENV"
  CONSOLE_NAMES="$names"
}


check_console() {
  local port="$1" code i
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/login" 2>/dev/null || echo 000)"
    case "$code" in
      2*|3*) ok "  console answering on :$port"; return 0 ;;
    esac
    sleep 2
  done
  note_failure "the operator console did not answer on :$port — run: $DKR compose -p opninfer-console --env-file $CONSOLE_ENV -f docker-compose.console.yml logs app"
  return 1
}

deploy_console() {
  [ "${OPNINFER_SKIP_CONSOLE:-0}" != "1" ] || { info "Skipping the operator console (OPNINFER_SKIP_CONSOLE=1)."; return 0; }
  info "Deploying the operator console…"
  ensure_console_env
  local pw port
  pw="$(env_get "$CONSOLE_ENV" CONSOLE_DB_PASSWORD)"
  if [ -z "$pw" ]; then
    warn "  console: no CONSOLE_DB_PASSWORD in $CONSOLE_ENV — skipping."
    return 0
  fi
  write_console_portals "$pw"
  if [ -z "${CONSOLE_NAMES:-}" ]; then
    warn "  console: no portal database could be prepared — skipping."
    return 0
  fi
  port="$(env_get "$CONSOLE_ENV" CONSOLE_PORT)"
  case "$port" in ''|*[!0-9]*) port=3000 ;; esac

  if ! dc -p opninfer-console --env-file "$CONSOLE_ENV" -f docker-compose.console.yml \
       up -d --no-build --remove-orphans; then
    note_failure "the operator console failed to start — run: $DKR compose -p opninfer-console --env-file $CONSOLE_ENV -f docker-compose.console.yml up -d"
    return 0
  fi
  connect_console_networks
  check_console "$port" || true
  CONSOLE_PORT_USED="$port"
  return 0
}

# --- deploy every instance --------------------------------------------------
SUMMARY=""
for ENV_FILE in instances/*.env; do
  NAME="$(basename "$ENV_FILE" .env)"
  info "Deploying instance '$NAME'…"
  # `|| true` + a default: under `set -euo pipefail` a missing APP_PORT line
  # (valid for compose, which defaults to 3000) killed the deploy silently
  # here — the "script simply vanished" class, again (audit 2026-09-05).
  # The sed also tolerates an unquoted hand edit (APP_PORT=3001).
  PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" 2>/dev/null | head -1 | sed -E 's/^APP_PORT="?([0-9]+)"?.*$/\1/' || true)"
  case "$PORT" in ''|*[!0-9]*) PORT=3000 ;; esac
  # Let in-flight replies land before the container is replaced. Neither of
  # these may ever block the update itself — a graceful restart is a nicety,
  # getting the new code running is the job.
  drain_instance "$NAME" "$ENV_FILE" "$PORT" || true
  ensure_deploy_token "$ENV_FILE" || true
  ensure_instance_identity "$ENV_FILE" "$NAME" || true
  # A failed `up` must not abandon the rest of the fleet. Unguarded, a bound
  # port or a failed migration on the first instance exited the script here —
  # leaving THAT instance drained but still on the old code, and instances 2, 3
  # and 4 never touched at all.
  if ! dc -p "opninfer-$NAME" --env-file "$ENV_FILE" -f docker-compose.yml \
       up -d --no-build --remove-orphans; then
    note_failure "$NAME: 'up' failed — this instance was NOT updated. Run: $DKR compose -p opninfer-$NAME --env-file $ENV_FILE -f docker-compose.yml up -d"
    # Let it keep serving the old code rather than sitting in maintenance mode.
    undrain_instance "$NAME" "$ENV_FILE" "$PORT" || true
    continue
  fi
  DOM="$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d'"' -f2 || true)"
  SUMMARY="$SUMMARY  $NAME: http://<this-host>:$PORT   →   https://$DOM\n"
  info "Checking instance '$NAME'…"
  check_instance "$NAME" "$ENV_FILE" "$PORT"
  # After the check, so the app is known to be answering before we tell it to
  # accept traffic again.
  undrain_instance "$NAME" "$ENV_FILE" "$PORT" || true
done

deploy_console || true

info "Checking the shared engines…"
check_engines

# Tidy up AFTER everything is running and verified: what's dangling by now is
# genuinely superseded. Never allowed to fail the deploy.
reclaim_space || true

# --- summary ----------------------------------------------------------------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
if [ -n "$FAILURES" ]; then
  printf '\033[31m✗ Deployed, but some checks FAILED:\033[0m\n'
  printf '%b' "$FAILURES"
  echo
  echo "The portal may still be usable — fix the above, then re-run ./deploy.sh."
  echo
  # Remembered for the exit status: anything wrapping this script (a person
  # reading $?, cron, CI) could not previously tell a partial deploy from a
  # clean one, because the red list still ended in exit 0.
  DEPLOY_STATUS=1
else
  ok "Deployment complete — all checks passed."
fi
echo
bold "Point your reverse proxy at:"
printf '%b' "${SUMMARY//<this-host>/${LAN_IP:-<this-host>}}"
echo
if [ -n "${CONSOLE_PORT_USED:-}" ]; then
  bold "Operator console (read-only, all portals):"
  echo "  http://${LAN_IP:-<this-host>}:$CONSOLE_PORT_USED"
  if [ -z "$(env_get "$CONSOLE_ENV" CONSOLE_OPERATORS_B64)" ]; then
    warn "  No console sign-in yet — run:  ./deploy.sh console-password"
  fi
  echo
fi
echo "Reverse-proxy requirements (per site):"
echo "  - forward Host + X-Forwarded-Proto headers"
echo "  - disable response buffering (chat streams over SSE)"
echo "  - allow request bodies ≥ the upload limit (default 50 MB)"
echo "  - generous read timeouts (replies can stream for minutes)"
echo
if [ "$NEW_INSTANCES" = "1" ]; then
  bold "Next steps for each new instance"
  echo "  1. Open  https://<its-domain>  → the first visit lands on /setup to create its admin."
  echo "  2. Admin → API:    add its OpenAI / Anthropic / Google key(s)."
  echo "  3. Admin → Models: bind the four assistant roles, then chat."
  echo "  4. Sandbox (optional): Admin → Tools → enable it. On a Claude plan: ./deploy.sh agent-token <name>"
  echo "     Connected services, e.g. Figma:  ./deploy.sh agent-mcp <name> add figma https://mcp.figma.com/mcp"
  echo "                                       ./deploy.sh agent-mcp <name> login figma"
  echo
  warn "BACK UP each instance's OPNINFER_MASTER_KEY (in instances/<name>.env) —"
  warn "without it, that instance's stored provider keys are unrecoverable."
  echo
fi
echo "Update everything:  ./deploy.sh"
echo "Add an instance:    ./deploy.sh add"
echo "Sandbox sign-in:    ./deploy.sh agent-token <name>   (agent-login is legacy — it signs itself out)"
echo "Sandbox services:   ./deploy.sh agent-mcp <name> add|login|list|remove|logout …"
echo "Console sign-in:    ./deploy.sh console-password"
echo "Follow one app log: $DKR compose -p opninfer-<name> logs -f app"

# Non-zero when any check failed, so a partial deploy is detectable.
exit "${DEPLOY_STATUS:-0}"
