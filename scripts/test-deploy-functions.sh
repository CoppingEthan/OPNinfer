#!/usr/bin/env bash
#
# Regression test for deploy.sh's drain/undrain helpers.
#
# These run inside a `set -euo pipefail` script, where a `grep` that matches
# nothing or a `curl` to a dead port is FATAL. That bit for real on 2026-07-30:
# an instance with no OPNINFER_DEPLOY_TOKEN (i.e. every instance created before
# draining existed) aborted the whole deploy at "Deploying instance…" — images
# built, nothing restarted, production left on the old version.
#
# The function bodies are extracted from deploy.sh itself rather than copied,
# so this can't drift away from what actually ships.
#
#   bash scripts/test-deploy-functions.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy.sh"
fails=0

check() { # label, expected-exit, actual-exit
  if [ "$2" = "$3" ]; then
    echo "✓ $1"
  else
    echo "✗ $1 — expected exit $2, got $3"
    fails=$((fails + 1))
  fi
}

# Pull the two helpers (and the logging/colour stubs they call) into a harness
# that mirrors deploy.sh's own shell options.
extract() { sed -n "/^$1() {/,/^}/p" "$DEPLOY"; }

HARNESS="$(mktemp)"
trap 'rm -f "$HARNESS" "$WITH" "$WITHOUT"' EXIT
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }; gen_token() { echo "generated-token"; }'
  echo 'DRAIN_WAIT_SECONDS=2'
  extract drain_instance
  extract undrain_instance
  extract ensure_deploy_token
  extract ensure_instance_identity
  extract preflight_storage
  extract free_gb
  extract reclaim_space
  echo '"$@"'
} > "$HARNESS"

WITHOUT="$(mktemp)"
printf 'APP_PORT="3999"\nDOMAIN="example.test"\n' > "$WITHOUT"

WITH="$(mktemp)"
printf 'APP_PORT="3999"\nOPNINFER_DEPLOY_TOKEN="abc123"\n' > "$WITH"

# 1. THE BUG: no token in the env file must be a clean no-op, not an abort.
bash "$HARNESS" drain_instance acme "$WITHOUT" 3999
check "drain_instance: missing token is a no-op (does not abort the deploy)" 0 $?

# 2. A token present but nothing listening on the port (instance down /
#    mid-rebuild) must also be survivable.
bash "$HARNESS" drain_instance acme "$WITH" 3999
check "drain_instance: unreachable instance is survivable" 0 $?

# 3. A missing env file must not explode either.
bash "$HARNESS" drain_instance acme /nonexistent/path.env 3999
check "drain_instance: missing env file is survivable" 0 $?

# 4. undrain_instance has the same two failure modes as drain_instance, and
#    matters more: it is what stops a portal sitting in "we're updating" for
#    ever after a re-run that recreated no container.
bash "$HARNESS" undrain_instance acme "$WITHOUT" 3999
check "undrain_instance: missing token is a no-op (does not abort the deploy)" 0 $?

bash "$HARNESS" undrain_instance acme "$WITH" 3999
check "undrain_instance: unreachable instance is survivable" 0 $?

bash "$HARNESS" undrain_instance acme /nonexistent/path.env 3999
check "undrain_instance: missing env file is survivable" 0 $?

# 5. ensure_deploy_token adds a token when absent…
bash "$HARNESS" ensure_deploy_token "$WITHOUT"
check "ensure_deploy_token: succeeds on a file with no token" 0 $?
if grep -qE '^OPNINFER_DEPLOY_TOKEN=' "$WITHOUT"; then
  echo "✓ ensure_deploy_token: token was appended"
else
  echo "✗ ensure_deploy_token: token was NOT appended"
  fails=$((fails + 1))
fi

# 6. …and is idempotent (a second deploy must not append a second token).
bash "$HARNESS" ensure_deploy_token "$WITHOUT"
check "ensure_deploy_token: idempotent" 0 $?
count="$(grep -cE '^OPNINFER_DEPLOY_TOKEN=' "$WITHOUT")"
if [ "$count" = "1" ]; then
  echo "✓ ensure_deploy_token: exactly one token line"
else
  echo "✗ ensure_deploy_token: $count token lines"
  fails=$((fails + 1))
fi

# 7. ensure_instance_identity: adds the sandbox-isolation name once, and never
#    aborts the deploy when it can't.
bash "$HARNESS" ensure_instance_identity "$WITHOUT" acme
check "ensure_instance_identity: succeeds on a file without one" 0 $?
if grep -q '^OPNINFER_INSTANCE="acme"$' "$WITHOUT"; then
  echo "OK   ensure_instance_identity: wrote the instance name"
else
  echo "FAIL ensure_instance_identity: instance name missing or malformed"
  fails=$((fails + 1))
fi
bash "$HARNESS" ensure_instance_identity "$WITHOUT" acme
count="$(grep -cE '^OPNINFER_INSTANCE=' "$WITHOUT")"
if [ "$count" = "1" ]; then
  echo "OK   ensure_instance_identity: idempotent"
else
  echo "FAIL ensure_instance_identity: $count instance lines"
  fails=$((fails + 1))
fi
bash "$HARNESS" ensure_instance_identity /nonexistent/path.env acme
check "ensure_instance_identity: unwritable file is survivable" 0 $?

# 8. preflight_storage is a WARNING function; it must never end the run. Its
#    grep for containerd's `root =` finds nothing on a stock host (the packaged
#    config comments the line out), and under `set -euo pipefail` that alone
#    killed the deploy before anything was built — with no output at all, the
#    same "the script simply vanished" symptom as the deploy-token bug.
CONF="$(mktemp)"
cat > "$CONF" <<'TOML'
version = 2
# root = "/var/lib/containerd"
[plugins]
TOML

PREFLIGHT="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }'
  echo 'DKR="true"'                      # stands in for the docker CLI
  echo 'df() { return 1; }'              # every disk probe finds nothing
  echo 'CONTAINERD_CONFIG="'"$CONF"'"'
  sed -n '/^preflight_storage() {/,/^}/p' "$DEPLOY"
  echo 'preflight_storage'
  echo 'echo SURVIVED'
} > "$PREFLIGHT"

out="$(bash "$PREFLIGHT" 2>/dev/null)"
status=$?
check "preflight_storage: a config with no 'root =' line does not abort the deploy" 0 $status
if [ "$out" = "SURVIVED" ]; then
  echo "OK   preflight_storage: ran to completion"
else
  echo "FAIL preflight_storage: did not reach the end (output: '$out')"
  fails=$((fails + 1))
fi

if grep -q '^preflight_storage || true$' "$DEPLOY"; then
  echo "OK   preflight_storage: guarded at the call site too"
else
  echo "FAIL preflight_storage: call site is unguarded"
  fails=$((fails + 1))
fi
rm -f "$CONF" "$PREFLIGHT"

# 9. reclaim_space runs DESTRUCTIVE docker commands on a live host, so what it
#    must never do matters more than what it does.
CLEAN="$(mktemp)"
CALLS="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }'
  # Record every docker invocation instead of running one.
  echo "DKR=\"record_docker\""
  echo "record_docker() { echo \"\$*\" >> \"$CALLS\"; }"
  echo 'df() { return 1; }'   # unknown free space — must not break the report
  sed -n '/^free_gb() {/,/^}/p' "$DEPLOY"
  sed -n '/^builder_supports_max_space() {/,/^}/p' "$DEPLOY"
  sed -n '/^prune_reclaimed() {/,/^}/p' "$DEPLOY"
  sed -n '/^reclaim_space() {/,/^}/p' "$DEPLOY"
  echo 'reclaim_space'
  echo 'echo SURVIVED'
} > "$CLEAN"

out="$(bash "$CLEAN" 2>/dev/null)"
check "reclaim_space: survives a host where free space can't be read" 0 $?
if [ "$out" = "SURVIVED" ]; then
  echo "OK   reclaim_space: ran to completion"
else
  echo "FAIL reclaim_space: did not finish (output: '$out')"
  fails=$((fails + 1))
fi

# The dangerous flags. `-a` on an image/system prune deletes TAGGED images
# nothing happens to be running — including the four shared engine images,
# ~7 GB to pull back — which would turn a tidy-up into an outage.
# (`builder prune --all` is exempt: build cache only — it cannot touch an
# image — and without --all the cap prunes nothing, found live 2026-09-02.)
if grep 'prune' "$CALLS" | grep -v 'builder prune' | grep -qE '(^| )(-a|--all)( |$)'; then
  echo "FAIL reclaim_space: used a prune that deletes tagged images"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: never prunes tagged images"
fi
if grep -q 'system prune' "$CALLS"; then
  echo "FAIL reclaim_space: used 'system prune'"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: no blanket system prune"
fi
if grep -q 'volume' "$CALLS"; then
  echo "FAIL reclaim_space: touched volumes (that is instance DATA)"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: never touches volumes"
fi
# Legacy tidy-up (v0.4): the old exec-tier sandbox containers and their
# network go by NAME. A `network prune` would take any network nothing is
# attached to at that instant — during a deploy that can include ours.
if grep -q 'network prune' "$CALLS"; then
  echo "FAIL reclaim_space: used 'network prune'"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: no blanket network prune"
fi
if grep -q 'network rm opninfer_sandbox_egress' "$CALLS"; then
  echo "OK   reclaim_space: removes the legacy sandbox network by name"
else
  echo "FAIL reclaim_space: legacy sandbox network not removed"
  fails=$((fails + 1))
fi
if grep -q "name=\^oi-sbx-" "$CALLS"; then
  echo "OK   reclaim_space: looks for legacy oi-sbx-* containers by name"
else
  echo "FAIL reclaim_space: does not look for legacy sandbox containers"
  fails=$((fails + 1))
fi
if grep 'builder prune' "$CALLS" | grep -qE '(^| )(-a|--all)( |$)'; then
  echo "OK   reclaim_space: build-cache prune uses --all (dangling-only prunes nothing on a rebuild host)"
else
  echo "FAIL reclaim_space: build-cache prune lacks --all — the cap never bites"
  fails=$((fails + 1))
fi
# The build cache is what makes the next deploy fast — it may only be pruned
# with an age filter, never wholesale.
if grep -q 'builder prune' "$CALLS"    && ! grep 'builder prune' "$CALLS" | grep -qE 'until=|--max-used-space'; then
  echo "FAIL reclaim_space: pruned the whole build cache"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: build cache bounded by age or size, never wiped"
fi

# And it must be skippable when someone needs the old images kept.
: > "$CALLS"
OPNINFER_SKIP_CLEANUP=1 bash "$CLEAN" >/dev/null 2>&1
if [ -s "$CALLS" ]; then
  echo "FAIL reclaim_space: ran despite OPNINFER_SKIP_CLEANUP=1"
  fails=$((fails + 1))
else
  echo "OK   reclaim_space: OPNINFER_SKIP_CLEANUP=1 stops it dead"
fi
rm -f "$CLEAN" "$CALLS"

# 10. prune_reclaimed reads BOTH summary formats. The classic prunes end with
#     "Total reclaimed space: 1.2GB"; `builder prune` is served by buildx and
#     ends with "Total:<TAB>1.2GB" — the old pattern matched only the first,
#     so every deploy printed "build cache 0B" whatever it freed (2026-09-04).
PR="$(mktemp)"
{
  echo 'set -euo pipefail'
  sed -n '/^prune_reclaimed() {/,/^}/p' "$DEPLOY"
  echo 'classic() { printf "Deleted Images:\nuntagged: x\n\nTotal reclaimed space: 1.2GB\n"; }'
  echo 'buildx()  { printf "ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nabc\ttrue\t3.4GB\t2 days ago\nTotal:\t3.4GB\n"; }'
  echo 'silent()  { :; }'
  echo 'echo "$(prune_reclaimed classic)|$(prune_reclaimed buildx)|$(prune_reclaimed silent)"'
} > "$PR"
out="$(bash "$PR" 2>/dev/null)"
if [ "$out" = "1.2GB|3.4GB|0B" ]; then
  echo "OK   prune_reclaimed: reads the classic AND the buildx summary (and 0B when there is none)"
else
  echo "FAIL prune_reclaimed: expected '1.2GB|3.4GB|0B', got '$out'"
  fails=$((fails + 1))
fi
rm -f "$PR"

# --- agent_mcp: the connected-services (MCP) wrapper (2026-09-03) -----------
# Thin wrappers over Claude Code's own `claude mcp …` inside the instance's
# credential volume. The checks pin the two things the app depends on: the
# volume is THAT instance's, and the flags are the ones the reader expects
# (user scope, http transport; a headless --no-browser login).
MCP_DIR="$(mktemp -d)"
mkdir -p "$MCP_DIR/instances"
: > "$MCP_DIR/instances/acme.env"
MCP_CALLS="$(mktemp)"
MCP_H="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }; die() { echo "die: $1" >&2; exit 1; }'
  echo "DKR=\"record_docker\""
  echo "record_docker() { echo \"\$*\" >> \"$MCP_CALLS\"; }"
  echo "cd \"$MCP_DIR\""
  extract agent_mcp
  echo '"$@"'
} > "$MCP_H"

: > "$MCP_CALLS"
bash "$MCP_H" agent_mcp acme add figma https://mcp.figma.com/mcp >/dev/null 2>&1
check "agent_mcp add: succeeds" 0 $?
if grep -q -- '-v opninfer-agent-config-acme:/home/sandbox/.claude opninfer-agent claude mcp add --transport http -s user figma https://mcp.figma.com/mcp' "$MCP_CALLS"; then
  echo "✓ agent_mcp add: THAT instance's volume, user scope, http transport"
else
  echo "✗ agent_mcp add: wrong docker invocation:"; sed 's/^/    /' "$MCP_CALLS"; fails=$((fails + 1))
fi

: > "$MCP_CALLS"
bash "$MCP_H" agent_mcp acme login figma >/dev/null 2>&1
check "agent_mcp login: succeeds" 0 $?
if grep -q -- 'run -it --rm -v opninfer-agent-config-acme:/home/sandbox/.claude opninfer-agent claude mcp login figma --no-browser' "$MCP_CALLS"; then
  echo "✓ agent_mcp login: interactive, headless (--no-browser) flow in the instance's volume"
else
  echo "✗ agent_mcp login: wrong docker invocation:"; sed 's/^/    /' "$MCP_CALLS"; fails=$((fails + 1))
fi

: > "$MCP_CALLS"
bash "$MCP_H" agent_mcp nosuch add figma https://mcp.figma.com/mcp >/dev/null 2>&1
check "agent_mcp: unknown instance is refused" 1 $?
bash "$MCP_H" agent_mcp acme add figma >/dev/null 2>&1
check "agent_mcp add: missing url is refused" 1 $?
bash "$MCP_H" agent_mcp acme add figma npx-some-server >/dev/null 2>&1
check "agent_mcp add: a non-http target is refused" 1 $?
bash "$MCP_H" agent_mcp acme frobnicate >/dev/null 2>&1
check "agent_mcp: unknown sub-command is refused" 1 $?
if grep -q 'claude mcp' "$MCP_CALLS"; then
  echo "✗ agent_mcp: a refused command still reached docker"; fails=$((fails + 1))
else
  echo "✓ agent_mcp: refused commands never reach docker"
fi
rm -rf "$MCP_DIR" "$MCP_CALLS" "$MCP_H"

# --- operator console -------------------------------------------------------
# The console reads every client's database, so the two things worth pinning
# are that a portal it cannot prepare is LEFT OUT rather than aborting the
# deploy (the "script simply vanished" class), and that the env-suffix rule
# still agrees with the TypeScript that consumes it.
CON_DIR="$(mktemp -d)"
CON_CALLS="$(mktemp)"
CON_H="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { echo "WARN: $*" >> "$CON_CALLS"; }; die() { exit 1; }'
  echo 'DKR="con_docker"'
  # A fake docker: `inspect` succeeds for known containers, `exec` records the
  # SQL it was handed, everything else is a no-op.
  echo 'con_docker() {'
  echo '  echo "docker $*" >> "$CON_CALLS"'
  echo '  case "$1" in'
  echo '    inspect) case "$2" in *-good-db-1) return 0 ;; *) return 1 ;; esac ;;'
  echo '    exec) cat >> "$CON_CALLS"; return 0 ;;'
  echo '  esac'
  echo '  return 0'
  echo '}'
  echo "CONSOLE_ENV=\"$CON_DIR/console.env\""
  echo "CONSOLE_PORTALS_ENV=\"$CON_DIR/console-portals.env\""
  sed -n '/^env_get() {/,/^}/p' "$DEPLOY"
  sed -n '/^env_suffix() {/,/^}/p' "$DEPLOY"
  sed -n '/^ensure_console_role() {/,/^}/p' "$DEPLOY"
  sed -n '/^write_console_portals() {/,/^}/p' "$DEPLOY"
  echo '"$@"'
} > "$CON_H"

mkdir -p "$CON_DIR/instances"
printf 'POSTGRES_USER="opninfer"\nPOSTGRES_DB="opninfer"\nDOMAIN="chat.good.co.uk"\n' > "$CON_DIR/instances/good.env"
printf 'POSTGRES_USER="opninfer"\nPOSTGRES_DB="opninfer"\nDOMAIN="chat.bad.co.uk"\n'  > "$CON_DIR/instances/bad.env"

( cd "$CON_DIR" && CON_CALLS="$CON_CALLS" bash "$CON_H" write_console_portals "secretpw" ) >/dev/null 2>&1
check "write_console_portals: a portal it cannot prepare does not abort the deploy" 0 $?

if grep -q 'CONSOLE_INSTANCES="good"' "$CON_DIR/console-portals.env" 2>/dev/null; then
  echo "✓ write_console_portals: lists only the portal whose role was created"
else
  echo "✗ write_console_portals: wrong instance list:"; sed 's/^/    /' "$CON_DIR/console-portals.env" 2>/dev/null; fails=$((fails + 1))
fi

if grep -q 'CONSOLE_DB_GOOD="postgresql://console_ro:secretpw@opninfer-good-db-1:5432/opninfer"' "$CON_DIR/console-portals.env" 2>/dev/null; then
  echo "✓ write_console_portals: connects by CONTAINER name, not the shared 'db' alias"
else
  echo "✗ write_console_portals: wrong connection string:"; sed 's/^/    /' "$CON_DIR/console-portals.env" 2>/dev/null; fails=$((fails + 1))
fi

if grep -q 'CONSOLE_LABEL_GOOD="chat.good.co.uk"' "$CON_DIR/console-portals.env" 2>/dev/null; then
  echo "✓ write_console_portals: labels a portal by its public domain"
else
  echo "✗ write_console_portals: missing or wrong label"; fails=$((fails + 1))
fi

# The role must be SELECT-only, and future migrations' tables must be covered
# — without the default-privileges grant the console goes blind on the next
# schema change and nothing says why.
if grep -q 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO console_ro' "$CON_CALLS" \
   && grep -q 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO console_ro' "$CON_CALLS"; then
  echo "✓ ensure_console_role: grants SELECT now and on future tables"
else
  echo "✗ ensure_console_role: missing a SELECT grant"; fails=$((fails + 1))
fi

for verb in INSERT UPDATE DELETE TRUNCATE "ALL PRIVILEGES"; do
  if grep -q "GRANT $verb" "$CON_CALLS"; then
    echo "✗ ensure_console_role: granted $verb — the console must be read-only"; fails=$((fails + 1))
  fi
done
echo "✓ ensure_console_role: grants no write privilege of any kind"

# Negative control for the assertion above (a malformed grep once made a
# check like this 'pass' by erroring out).
if grep -q "GRANT SELECT" "$CON_CALLS"; then
  echo "✓ ensure_console_role: (control) the recorded SQL is searchable"
else
  echo "✗ ensure_console_role: (control) recorded no SQL — the checks above proved nothing"; fails=$((fails + 1))
fi

# Must agree with envSuffix() in src/lib/console/instances.ts, or the console
# silently sees no portals.
for pair in "acme:ACME" "ini-tech:INI_TECH" "initech:INITECH"; do
  want="${pair#*:}"
  got="$(bash "$CON_H" env_suffix "${pair%%:*}")"
  if [ "$got" = "$want" ]; then
    echo "✓ env_suffix: ${pair%%:*} → $want"
  else
    echo "✗ env_suffix: ${pair%%:*} → got '$got', want '$want'"; fails=$((fails + 1))
  fi
done

# A missing key must be empty, not fatal.
bash "$CON_H" env_get "$CON_DIR/instances/good.env" NOPE >/dev/null 2>&1
check "env_get: a key that isn't there is survivable" 0 $?

rm -rf "$CON_DIR" "$CON_CALLS" "$CON_H"

# THE BUG (2026-09-07, hit on the second real deploy): the console's env files
# were written into `instances/`, which deploy.sh treats as the PORTAL list —
# it picks the first match as the env file for the image build, loops over
# them to deploy, and scans them for free ports. `console-portals.env` sorts
# alphabetically FIRST, so the build ran with an env file that has no
# SANDBOX_BROKER_TOKEN and died with "required variable ... is missing a
# value". It only broke on the SECOND deploy, once the files existed.
MIG_DIR="$(mktemp -d)"
MIG_H="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }'
  sed -n '/^CONSOLE_DIR=/,/^CONSOLE_PORTALS_ENV=/p' "$DEPLOY"
  sed -n '/^LEGACY_CONSOLE_ENV=/,/^LEGACY_CONSOLE_PORTALS_ENV=/p' "$DEPLOY"
  sed -n '/^migrate_console_env() {/,/^}/p' "$DEPLOY"
  echo '"$@"'
} > "$MIG_H"

mkdir -p "$MIG_DIR/instances"
printf 'APP_PORT="3001"\nSANDBOX_BROKER_TOKEN="tok"\n' > "$MIG_DIR/instances/acme.env"
printf 'CONSOLE_PORT="3000"\nCONSOLE_OPERATORS="me@x:$argon2id$keepme"\n' > "$MIG_DIR/instances/console.env"
printf 'CONSOLE_INSTANCES="acme"\n' > "$MIG_DIR/instances/console-portals.env"

( cd "$MIG_DIR" && bash "$MIG_H" migrate_console_env ) >/dev/null 2>&1
check "migrate_console_env: an old layout is moved, not left to break the build" 0 $?

FIRST="$(cd "$MIG_DIR" && ls instances/*.env | head -1)"
if [ "$FIRST" = "instances/acme.env" ]; then
  echo "✓ console config is invisible to the instances/*.env glob (build picks a real portal)"
else
  echo "✗ the build would still pick '$FIRST' as its env file"; fails=$((fails + 1))
fi

if grep -q 'keepme' "$MIG_DIR/instances/console/console.env" 2>/dev/null; then
  echo "✓ migrate_console_env: the operator's password hash survives the move"
else
  echo "✗ migrate_console_env: lost the console's accounts"; fails=$((fails + 1))
fi

if [ -f "$MIG_DIR/instances/console/portals.env" ] && [ ! -f "$MIG_DIR/instances/console-portals.env" ]; then
  echo "✓ migrate_console_env: the generated portal list moves too"
else
  echo "✗ migrate_console_env: the portal list was left behind"; fails=$((fails + 1))
fi

# Idempotent, and a no-op on a host that never had the old layout.
( cd "$MIG_DIR" && bash "$MIG_H" migrate_console_env ) >/dev/null 2>&1
check "migrate_console_env: re-running is a clean no-op" 0 $?
CLEAN_DIR="$(mktemp -d)"; mkdir -p "$CLEAN_DIR/instances"
( cd "$CLEAN_DIR" && bash "$MIG_H" migrate_console_env ) >/dev/null 2>&1
check "migrate_console_env: nothing to migrate is survivable" 0 $?

rm -rf "$MIG_DIR" "$CLEAN_DIR" "$MIG_H"

# The console reaches each portal's database by joining that project's docker
# network. A silent failure there looks exactly like "every portal is down",
# with nothing in any log — so the attach must be verified, and a network the
# label lookup cannot find must still fall back to the derived name.
NET_CALLS="$(mktemp)"
NET_H="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { echo "WARN: $*" >> "$NET_CALLS"; }'
  echo 'DKR="net_docker"'
  echo 'net_docker() {'
  echo '  echo "docker $*" >> "$NET_CALLS"'
  echo '  case "$1" in'
  # `network ls` finds a labelled network for `good` and nothing for `bare`.
  echo '    network)'
  echo '      case "$*" in'
  echo '        *ls*opninfer-good*) echo "opninfer-good_default" ;;'
  echo '        *ls*) : ;;'
  echo '      esac ;;'
  # `inspect` reports the console attached to good + bare but NOT lost.
  echo '    inspect) echo "bridge opninfer-good_default opninfer-bare_default " ;;'
  echo '  esac'
  echo '  return 0'
  echo '}'
  sed -n '/^connect_console_networks() {/,/^}/p' "$DEPLOY"
  echo '"$@"'
} > "$NET_H"

CONSOLE_NAMES="good bare lost" NET_CALLS="$NET_CALLS" bash "$NET_H" connect_console_networks >/dev/null 2>&1
check "connect_console_networks: an unattachable portal does not abort the deploy" 0 $?

if grep -q "network connect opninfer-good_default opninfer-console-app-1" "$NET_CALLS"; then
  echo "✓ connect_console_networks: uses the network compose actually labelled"
else
  echo "✗ connect_console_networks: did not use the labelled network:"; sed 's/^/    /' "$NET_CALLS"; fails=$((fails + 1))
fi

if grep -q "network connect opninfer-bare_default opninfer-console-app-1" "$NET_CALLS"; then
  echo "✓ connect_console_networks: falls back to the derived name when the label lookup finds nothing"
else
  echo "✗ connect_console_networks: no fallback to the derived name"; fails=$((fails + 1))
fi

if grep -q "WARN:.*could not attach to 'opninfer-lost_default'" "$NET_CALLS"; then
  echo "✓ connect_console_networks: WARNS when the attach did not take (would read as 'portal down')"
else
  echo "✗ connect_console_networks: a failed attach was swallowed"; sed 's/^/    /' "$NET_CALLS"; fails=$((fails + 1))
fi

if grep -q "WARN:.*opninfer-good_default" "$NET_CALLS"; then
  echo "✗ connect_console_networks: warned about a network it DID attach to"; fails=$((fails + 1))
else
  echo "✓ connect_console_networks: (control) stays quiet about the ones that worked"
fi

rm -f "$NET_CALLS" "$NET_H"


# THE BUG (found live, 2026-09-07): the console's operator accounts were
# written into an env_file as `email:$argon2id$v=19$m=...`, and DOCKER COMPOSE
# INTERPOLATES `$` there — `$argon2id`, `$v`, `$m` and `$p` were substituted
# as undefined variables, so 147 bytes in the file reached the container as 88
# with the algorithm name gone. The console reported "no operator accounts are
# configured", which is indistinguishable from never having set one. Base64
# has no `$` for compose to eat.
PW_ENV="$(mktemp -d)/console.env"
mkdir -p "$(dirname "$PW_ENV")"
printf 'CONSOLE_PORT="3000"\nCONSOLE_OPERATORS_B64=""\n' > "$PW_ENV"
PW_H="$(mktemp)"
{
  echo 'set -euo pipefail'
  echo 'info() { :; }; ok() { :; }; warn() { :; }; die() { exit 1; }'
  echo "CONSOLE_ENV=\"$PW_ENV\""
  sed -n '/^env_get() {/,/^}/p' "$DEPLOY"
  # Just the account-list rewrite out of console_password, with the pieces it
  # would otherwise get from the prompt and the app image.
  echo 'write_account() {'
  echo '  local email="$1" hash="$2" existing kept entry encoded line'
  sed -n '/# Replace this address if it is already listed/,/chmod 600 "\$CONSOLE_ENV"/p' "$DEPLOY"
  echo '}'
  echo '"$@"'
} > "$PW_H"

HASH_A='$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo'
bash "$PW_H" write_account "a@x.com" "$HASH_A" >/dev/null 2>&1
check "console_password: writes the account list" 0 $?

if grep -q '^CONSOLE_OPERATORS_B64=' "$PW_ENV" && ! grep -q '^CONSOLE_OPERATORS=' "$PW_ENV"; then
  echo "✓ console_password: writes ONLY the base64 form"
else
  echo "✗ console_password: wrote a plain form compose would corrupt"; fails=$((fails + 1))
fi

# The stored value must contain no `$` at all — that is the whole point.
STORED="$(grep '^CONSOLE_OPERATORS_B64=' "$PW_ENV" | sed -E 's/^[^=]+="?([^"]*)"?.*/\1/')"
case "$STORED" in
  *'$'*) echo "✗ console_password: the stored value still contains a \$"; fails=$((fails + 1)) ;;
  "") echo "✗ console_password: stored nothing"; fails=$((fails + 1)) ;;
  *) echo "✓ console_password: the stored value has no \$ for compose to interpolate" ;;
esac

DECODED="$(printf '%s' "$STORED" | base64 -d 2>/dev/null || true)"
if [ "$DECODED" = "a@x.com:$HASH_A" ]; then
  echo "✓ console_password: the hash round-trips through base64 byte for byte"
else
  echo "✗ console_password: hash did not survive — got '$DECODED'"; fails=$((fails + 1))
fi

# A second account is kept; the same address is replaced, not duplicated.
HASH_B='$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0$b3RoZXJoYXNo'
bash "$PW_H" write_account "b@y.com" "$HASH_B" >/dev/null 2>&1
DECODED="$(grep '^CONSOLE_OPERATORS_B64=' "$PW_ENV" | sed -E 's/^[^=]+="?([^"]*)"?.*/\1/' | base64 -d 2>/dev/null || true)"
case "$DECODED" in
  *"a@x.com:$HASH_A"*"b@y.com:$HASH_B"*) echo "✓ console_password: a second account is added, the first kept" ;;
  *) echo "✗ console_password: lost an account — '$DECODED'"; fails=$((fails + 1)) ;;
esac

bash "$PW_H" write_account "a@x.com" "$HASH_B" >/dev/null 2>&1
DECODED="$(grep '^CONSOLE_OPERATORS_B64=' "$PW_ENV" | sed -E 's/^[^=]+="?([^"]*)"?.*/\1/' | base64 -d 2>/dev/null || true)"
if [ "$(printf '%s' "$DECODED" | tr ';' '\n' | grep -c '^a@x.com:')" = "1" ]; then
  echo "✓ console_password: re-setting an address replaces it rather than duplicating"
else
  echo "✗ console_password: duplicated an address — '$DECODED'"; fails=$((fails + 1))
fi

# A hash already mangled by compose must be DROPPED, not carried for ever.
printf 'CONSOLE_OPERATORS_B64="%s"\n' "$(printf '%s' 'dead@x.com:=19=19456,t=2,p=1' | base64 -w0)" > "$PW_ENV"
bash "$PW_H" write_account "new@x.com" "$HASH_A" >/dev/null 2>&1
DECODED="$(grep '^CONSOLE_OPERATORS_B64=' "$PW_ENV" | sed -E 's/^[^=]+="?([^"]*)"?.*/\1/' | base64 -d 2>/dev/null || true)"
case "$DECODED" in
  *dead@x.com*) echo "✗ console_password: kept an account whose hash can never verify"; fails=$((fails + 1)) ;;
  *new@x.com*) echo "✓ console_password: a hash mangled by compose is dropped, not kept for ever" ;;
  *) echo "✗ console_password: lost the new account too — '$DECODED'"; fails=$((fails + 1)) ;;
esac

rm -rf "$(dirname "$PW_ENV")" "$PW_H"

# The confirmation after console-password must ASK THE CONSOLE, not inspect
# the plumbing. Two checks here have now confirmed the wrong layer: the value
# reaching the container is not the same as the running image being able to
# read it (2026-09-07 — the env was perfect and the screen still said "no
# operator accounts are configured", because the image predated the reader).
VERIFY_BLOCK="$(sed -n "/ASK THE CONSOLE/,/^      esac/p" "$DEPLOY")"
if printf '%s' "$VERIFY_BLOCK" | grep -q 'curl .*127\.0\.0\.1:\$port/login'; then
  echo "✓ console-password confirms by fetching the console's own sign-in page"
else
  echo "✗ console-password does not check the console itself"; fails=$((fails + 1))
fi
if printf '%s' "$VERIFY_BLOCK" | grep -q 'No operator accounts are configured'; then
  echo "✓ console-password names the stale-image case specifically"
else
  echo "✗ console-password cannot tell a stale image from a bad account"; fails=$((fails + 1))
fi
if printf '%s' "$VERIFY_BLOCK" | grep -q 'docker exec\|\$DKR exec'; then
  echo "✗ console-password is back to inspecting the container's env"; fails=$((fails + 1))
else
  echo "✓ console-password does not settle for the env having arrived"
fi


# An unrecognised argument must not fall through to a full deploy. Asserted
# against the SOURCE rather than by running deploy.sh: this script would try
# to INSTALL DOCKER on a host that has none, which is not something a test
# gets to do. What matters is that the guard exists, exits non-zero, and sits
# BEFORE the pull — `./deploy.sh randompass` rebuilt and recreated four client
# portals (2026-09-07).
GUARD_LINE="$(grep -n '^case "\${1:-}" in' "$DEPLOY" | head -1 | cut -d: -f1)"
PULL_LINE="$(grep -n 'Pulling the latest version from GitHub' "$DEPLOY" | head -1 | cut -d: -f1)"
if [ -n "$GUARD_LINE" ] && [ -n "$PULL_LINE" ] && [ "$GUARD_LINE" -lt "$PULL_LINE" ]; then
  echo "✓ unknown-argument guard runs before the git pull"
else
  echo "✗ unknown-argument guard is missing or runs too late (guard=$GUARD_LINE pull=$PULL_LINE)"; fails=$((fails + 1))
fi
if sed -n "${GUARD_LINE:-1},$((${GUARD_LINE:-1} + 20))p" "$DEPLOY" | grep -q 'exit 2'; then
  echo "✓ unknown-argument guard exits non-zero"
else
  echo "✗ unknown-argument guard does not exit non-zero"; fails=$((fails + 1))
fi
if sed -n "${GUARD_LINE:-1},$((${GUARD_LINE:-1} + 20))p" "$DEPLOY" | grep -q '""|add)'; then
  echo "✓ unknown-argument guard still lets a bare run and 'add' through"
else
  echo "✗ unknown-argument guard would block a normal deploy"; fails=$((fails + 1))
fi

# --- agent-token (2026-09-07) ------------------------------------------------
# A long-lived Claude token instead of the refreshing volume login, so the
# Sandbox stops signing itself out every eight hours. Source-asserted for the
# same reason as the guard above: running it would want Docker and a browser.

AT_BLOCK="$(sed -n '/^agent_token() {/,/^}/p' "$DEPLOY")"
if [ -z "$AT_BLOCK" ]; then
  echo "✗ agent_token: the function is missing"; fails=$((fails + 1))
else
  # Stored base64. A `$` in an env_file is interpolated by compose — the bug
  # that silently truncated the console's operator hash — and a token's
  # alphabet is not ours to promise.
  if printf '%s' "$AT_BLOCK" | grep -q 'AGENT_OAUTH_TOKEN_B64="%s"'; then
    echo "✓ agent-token stores the token base64-encoded"
  else
    echo "✗ agent-token does not store the token base64-encoded"; fails=$((fails + 1))
  fi
  if printf '%s' "$AT_BLOCK" | grep -qF "grep -vE '^AGENT_OAUTH_TOKEN(_B64)?='"; then
    echo "✓ agent-token replaces any previous token rather than appending a second"
  else
    echo "✗ agent-token could leave two token lines in the env file"; fails=$((fails + 1))
  fi
  if printf '%s' "$AT_BLOCK" | grep -q 'chmod 600'; then
    echo "✓ agent-token leaves the env file readable only by its owner"
  else
    echo "✗ agent-token does not chmod the env file"; fails=$((fails + 1))
  fi
  # An org API key here would put a raw key inside a container that runs
  # model-written code, and would bill the API while the admin believed they
  # were on the plan.
  if printf '%s' "$AT_BLOCK" | grep -q 'sk-ant-api\*) why='; then
    echo "✓ agent-token refuses an organisation API key"
  else
    echo "✗ agent-token would accept an API key as a plan token"; fails=$((fails + 1))
  fi
  # A paste that does not land must be RE-ASKED, not fatal: the CLI shows the
  # token once and never again, so giving up throws away a live credential
  # and costs a second `setup-token` run (2026-09-07, first real use).
  if printf '%s' "$AT_BLOCK" | grep -q 'while \[ "$tries" -lt 3 \]'; then
    echo "✓ agent-token re-asks for the token instead of dying on a bad paste"
  else
    echo "✗ agent-token discards a freshly minted token on one bad paste"; fails=$((fails + 1))
  fi
  # A token cannot read the plan's usage screen, and the effect is SILENT:
  # the panel simply stops gaining numbers. Said at the moment it matters,
  # and only when the volume has no sign-in.
  if printf '%s' "$AT_BLOCK" | grep -q "not tracked on a token\|not tracked"; then
    echo "✓ agent-token says plan usage is not tracked on a token"
  else
    echo "✗ agent-token leaves plan usage silently missing"; fails=$((fails + 1))
  fi
  # …and must NOT send people to the deprecated login to get it back.
  if printf '%s' "$AT_BLOCK" | grep -q 'deploy.sh agent-login'; then
    echo "✗ agent-token still recommends the unsupported agent-login"; fails=$((fails + 1))
  else
    echo "✓ agent-token does not point at the unsupported login"
  fi
  # The paste must not land in the terminal scrollback.
  if printf '%s' "$AT_BLOCK" | grep -q 'read -r -s token'; then
    echo "✓ agent-token reads the token without echoing it"
  else
    echo "✗ agent-token echoes the pasted token"; fails=$((fails + 1))
  fi
  # A live reply must not be cut off for a change nobody is waiting on.
  if printf '%s' "$AT_BLOCK" | grep -q 'drain_instance' && printf '%s' "$AT_BLOCK" | grep -q 'undrain_instance'; then
    echo "✓ agent-token drains before recreating the app, and undrains after"
  else
    echo "✗ agent-token restarts the app without draining"; fails=$((fails + 1))
  fi
  # THE LESSON FROM console-password, applied here before it can bite: ask the
  # app what credential it will use, rather than trusting that the file was
  # written or that the value reached the container.
  if printf '%s' "$AT_BLOCK" | grep -q 'api/admin/agent-credential'; then
    echo "✓ agent-token confirms by asking the running app"
  else
    echo "✗ agent-token does not confirm the change with the app itself"; fails=$((fails + 1))
  fi
  if printf '%s' "$AT_BLOCK" | grep -q '"source":"none"' && printf '%s' "$AT_BLOCK" | grep -q 'OLDER BUILD'; then
    echo "✓ agent-token names the stale-image case specifically"
  else
    echo "✗ agent-token cannot tell a stale image from a bad token"; fails=$((fails + 1))
  fi
  # It must never be echoed back to the terminal. The only use of "$token"
  # that is allowed to reach a command is the pipe into base64 (printf is a
  # builtin, so it never appears in `ps` either); its length is what gets
  # reported to the operator.
  if printf '%s' "$AT_BLOCK" | grep -qE '^[[:space:]]*(echo|printf)[^=]*\$\{?token\}?'; then
    echo "✗ agent-token prints the token somewhere"; fails=$((fails + 1))
  else
    echo "✓ agent-token never echoes the token back"
  fi
  if printf '%s' "$AT_BLOCK" | grep -q '\${#token}'; then
    echo "✓ agent-token reports the token's length instead of the token"
  else
    echo "✗ agent-token gives the operator no confirmation the paste landed"; fails=$((fails + 1))
  fi
fi

# agent-login is DEPRECATED, not deleted (2026-09-07 owner decision). It is
# still the only way to mint a token or to sign a volume in for plan-usage
# readings, so it must keep working — while saying plainly that it should not
# be an instance's credential.
LOGIN_BLOCK="$(sed -n '/# `.\/deploy.sh agent-login <instance>`/,/^fi$/p' "$DEPLOY")"
if [ -z "$LOGIN_BLOCK" ]; then
  echo "✗ agent-login has been removed — it is still needed to mint a token"; fails=$((fails + 1))
else
  if printf '%s' "$LOGIN_BLOCK" | grep -q 'no longer the supported way'; then
    echo "✓ agent-login warns that it is no longer supported"
  else
    echo "✗ agent-login gives no hint that it is the path that signs itself out"; fails=$((fails + 1))
  fi
  if printf '%s' "$LOGIN_BLOCK" | grep -q 'agent-token'; then
    echo "✓ agent-login points at agent-token instead"
  else
    echo "✗ agent-login does not say what to use instead"; fails=$((fails + 1))
  fi
  # Deprecated must still mean WORKING: agent-token runs the login flow
  # through this very command.
  if printf '%s' "$LOGIN_BLOCK" | grep -q 'opninfer-agent claude$'; then
    echo "✓ agent-login still actually runs the login"
  else
    echo "✗ agent-login has been gutted, not deprecated"; fails=$((fails + 1))
  fi
fi

# --- agent-logout (2026-09-07) -----------------------------------------------
# Taking an instance OFF the plan has TWO halves — the token in the env file
# and the sign-in in the credential volume — and leaving either behind means
# it is still quietly drawing on someone's plan.
AL_BLOCK="$(sed -n '/^agent_logout() {/,/^}/p' "$DEPLOY")"
if [ -z "$AL_BLOCK" ]; then
  echo "✗ agent_logout: the function is missing"; fails=$((fails + 1))
else
  if printf '%s' "$AL_BLOCK" | grep -qF "grep -vE '^AGENT_OAUTH_TOKEN(_B64)?='"; then
    echo "✓ agent-logout removes the token from the env file"
  else
    echo "✗ agent-logout leaves the token in the env file"; fails=$((fails + 1))
  fi
  if printf '%s' "$AL_BLOCK" | grep -q 'claude auth logout'; then
    echo "✓ agent-logout signs the credential volume out too"
  else
    echo "✗ agent-logout leaves the volume signed in"; fails=$((fails + 1))
  fi
  # The volume must SURVIVE: connected services keep their own OAuth in the
  # same file and are set up per instance at some cost.
  if printf '%s' "$AL_BLOCK" | grep -qE 'volume (rm|prune)'; then
    echo "✗ agent-logout deletes the credential volume, taking MCP sign-ins with it"; fails=$((fails + 1))
  else
    echo "✓ agent-logout keeps the volume, so connected services survive"
  fi
  # It must not claim success it has not checked.
  if printf '%s' "$AL_BLOCK" | grep -q 'grep -c claudeAiOauth'; then
    echo "✓ agent-logout verifies the sign-in is actually gone"
  else
    echo "✗ agent-logout assumes the logout worked"; fails=$((fails + 1))
  fi
  # The credential MODE lives in the portal's database, not here.
  if printf '%s' "$AL_BLOCK" | grep -q 'not scriptable'; then
    echo "✓ agent-logout says the admin-side switch is still needed"
  else
    echo "✗ agent-logout implies the instance is fully switched over"; fails=$((fails + 1))
  fi
  # A recreated app takes seconds to answer; ONE early curl reported "no
  # answer" for an instance that was in fact fine (2026-09-07, first use).
  if printf '%s' "$AL_BLOCK" | grep -q 'for i in 1 2 3'; then
    echo "✓ agent-logout waits for the app to come back before judging it"
  else
    echo "✗ agent-logout calls a cold start a failure"; fails=$((fails + 1))
  fi
fi
AL_DISPATCH="$(grep -n 'if \[ "\${1:-}" = "agent-logout" \]' "$DEPLOY" | head -1 | cut -d: -f1)"
if [ -n "$AL_DISPATCH" ] && [ -n "$GUARD_LINE" ] && [ "$AL_DISPATCH" -lt "$GUARD_LINE" ]; then
  echo "✓ agent-logout is dispatched before the unknown-argument guard"
else
  echo "✗ agent-logout would be rejected as an unknown argument"; fails=$((fails + 1))
fi

# drain_instance must be DEFINED before the agent subcommands that call it:
# they run and exit long before the deploy loop, and a function called before
# its definition is simply "command not found" under set -e.
DRAIN_DEF="$(grep -n '^drain_instance() {' "$DEPLOY" | head -1 | cut -d: -f1)"
AT_DEF="$(grep -n '^agent_token() {' "$DEPLOY" | head -1 | cut -d: -f1)"
WAIT_DEF="$(grep -n '^DRAIN_WAIT_SECONDS=' "$DEPLOY" | head -1 | cut -d: -f1)"
if [ -n "$DRAIN_DEF" ] && [ -n "$AT_DEF" ] && [ "$DRAIN_DEF" -lt "$AT_DEF" ]; then
  echo "✓ drain_instance is defined before agent-token uses it"
else
  echo "✗ agent-token calls drain_instance before it exists (drain=$DRAIN_DEF agent=$AT_DEF)"; fails=$((fails + 1))
fi
if [ -n "$WAIT_DEF" ] && [ -n "$DRAIN_DEF" ] && [ "$WAIT_DEF" -lt "$DRAIN_DEF" ]; then
  echo "✓ DRAIN_WAIT_SECONDS is set before the drain that reads it"
else
  echo "✗ DRAIN_WAIT_SECONDS is set too late for agent-token's drain"; fails=$((fails + 1))
fi

# The dispatch has to sit before the unknown-argument guard, or the guard
# rejects it — the same shape agent-login and agent-mcp already have.
AT_DISPATCH="$(grep -n 'if \[ "\${1:-}" = "agent-token" \]' "$DEPLOY" | head -1 | cut -d: -f1)"
if [ -n "$AT_DISPATCH" ] && [ -n "$GUARD_LINE" ] && [ "$AT_DISPATCH" -lt "$GUARD_LINE" ]; then
  echo "✓ agent-token is dispatched before the unknown-argument guard"
else
  echo "✗ agent-token would be rejected as an unknown argument"; fails=$((fails + 1))
fi

echo
if [ "$fails" = "0" ]; then
  echo "ALL DEPLOY-FUNCTION CHECKS PASSED"
else
  echo "$fails CHECK(S) FAILED"
fi
exit "$fails"
