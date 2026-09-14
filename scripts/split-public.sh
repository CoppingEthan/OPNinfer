#!/usr/bin/env bash
#
# The product is developed here, in the open. A private deployment of it can
# carry capabilities built for one organisation — against that organisation's
# own systems and data — which are nobody else's business. This script is the
# boundary between the two, and the checks that keep it honest.
#
# NOTHING in this file names a client, and that is deliberate: a blocklist of
# names has to contain the names, so a public repository cannot hold one
# without publishing exactly what it exists to protect. Instead:
#
#   * here it checks the INVARIANT — the capability seam registers nothing,
#     and no private file is present. That is generic, and leaks nothing.
#   * a private deployment drops a `split-private.conf` beside this file
#     naming its own files and strings, and the same commands check those too.
#
#   ./scripts/split-public.sh guard    fail if anything private is in this repo
#                                      (runs in CI; useful in both repos)
#   ./scripts/split-public.sh list     what a deployment keeps to itself
#   ./scripts/split-public.sh export <dir>   build the public tree from HEAD
#   ./scripts/split-public.sh check    has this deployment edited a file that
#                                      belongs upstream?
#
# The last three need `split-private.conf`; in the public repository they have
# nothing to do.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CONF="$HERE/split-private.conf"

# Files the public repository must never contain, named by their ROLE rather
# than by any client: a deployment's own log, and its private configuration for
# this script — if that were here, everything it names would be here too.
GENERIC_PRIVATE=( "OPERATIONS.md" "scripts/split-private.conf" )

# The seam. Everything else rests on this file registering nothing upstream.
SEAM="src/lib/capabilities/local.ts"

PRIVATE_ONLY=() ; DIVERGES=() ; FORBIDDEN=""
HAVE_CONF=0
if [ -f "$CONF" ]; then . "$CONF"; HAVE_CONF=1; fi

need_conf() {
  [ "$HAVE_CONF" = 1 ] && return 0
  echo "This command needs scripts/split-private.conf, which only a private" >&2
  echo "deployment has. In the public repository there is nothing to split." >&2
  exit 1
}

public_seam() {
  cat <<'TS'
import type { Capability } from "./types";

/**
 * Capabilities built for ONE organisation, which therefore do not ship in the
 * public product.
 *
 * This file is the seam. Here it is an EMPTY list, permanently — nothing
 * upstream should ever edit it. A private deployment that carries client
 * tooling replaces this one file and adds its capability modules alongside it;
 * because upstream never touches it, pulling upstream into such a repository
 * can never conflict here, and because everything else a client capability
 * needs is a NEW file, the whole private layer is additive.
 *
 * A capability is a self-contained module implementing `Capability` (see
 * `types.ts`): its own tools, its own config schema, its own data source. It
 * ships switched OFF and is enabled per instance on Admin → Tools, which
 * renders it generically — including the data-source line it declares for
 * itself — without ever knowing its id.
 *
 * To add one:
 *
 *     import { acmeListings } from "./acme-listings";
 *     export const LOCAL_CAPABILITIES: Capability[] = [acmeListings];
 */
export const LOCAL_CAPABILITIES: Capability[] = [];
TS
}

# --- the generic invariant, checked with no knowledge of any client ---------
check_invariant() {
  local where="${1:-$ROOT}" fail=0 f

  for f in "${GENERIC_PRIVATE[@]}"; do
    if [ -e "$where/$f" ]; then
      echo "  $f is present, and must never be in the public repository" >&2
      fail=1
    fi
  done

  if [ ! -f "$where/$SEAM" ]; then
    echo "  $SEAM is missing — the capability seam must exist" >&2
    fail=1
  else
    # Both halves matter: an empty array beside a live import is dead client
    # code shipped anyway, and a filled array is the leak itself.
    grep -qE '^export const LOCAL_CAPABILITIES: Capability\[\] = \[\];[[:space:]]*$' "$where/$SEAM" || {
      echo "  $SEAM does not export an EMPTY LOCAL_CAPABILITIES — a client" >&2
      echo "    capability is registered in the public product" >&2
      fail=1
    }
    local bad
    bad="$(grep -E '^[[:space:]]*import\b' "$where/$SEAM" | grep -v '"\./types"' || true)"
    if [ -n "$bad" ]; then
      echo "  $SEAM imports something other than ./types:" >&2
      echo "$bad" | sed 's/^/      /' >&2
      fail=1
    fi
  fi
  return $fail
}

# "Is anything private here?" — but that question means something different
# depending on which repository is asking, and getting it wrong makes the check
# useless in one of them.
#
#   PUBLIC repo (no conf): ask it of THIS tree. Nothing private may be here.
#   PRIVATE deployment (conf): the private files are SUPPOSED to be here, so
#     asking it of this tree would fail every time and teach nobody anything.
#     Ask it of what this deployment WOULD PUBLISH instead — export from HEAD
#     into a temporary tree and check that. Same question, right subject.
cmd_guard() {
  if [ "$HAVE_CONF" = 1 ]; then
    local tmp status=0
    tmp="$(mktemp -d)"
    cmd_export "$tmp/tree" >/dev/null || status=1
    rm -rf "$tmp"
    [ "$status" = 0 ] || exit 1
    echo "Guard: what this deployment would publish is clean (invariant + its own list)."
    return 0
  fi

  check_invariant "$ROOT" || { echo >&2; echo "Guard FAILED." >&2; exit 1; }
  echo "Guard: clean (invariant)."
}

cmd_list() {
  need_conf
  local f
  echo "Private to this deployment (absent from the public tree):"
  for f in "${PRIVATE_ONLY[@]}"; do
    printf '  %-48s %s\n' "$f" "$([ -e "$ROOT/$f" ] && echo present || echo MISSING)"
  done
  echo
  echo "Present in both, allowed to differ:"
  for f in "${DIVERGES[@]}"; do printf '  %s\n' "$f"; done
  echo
  echo "Everything else must be byte-identical to upstream."
}

cmd_export() {
  need_conf
  local dest="${1:?usage: split-public.sh export <dir>}"
  [ -e "$dest" ] && { echo "refusing to write into an existing path: $dest" >&2; exit 1; }
  mkdir -p "$dest"

  # From HEAD, not the working tree: an export must be reproducible, and must
  # never pick up a file someone forgot to commit.
  #
  # Which cuts both ways, so say so. Checking HEAD means an uncommitted leak
  # passes silently, and a clean result on a dirty tree is false confidence
  # about the very thing you are running this to be sure of.
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "NOTE: uncommitted changes are NOT checked — this reads HEAD." >&2
    echo "      Commit first if you are checking something you just edited." >&2
    echo >&2
  fi
  git -C "$ROOT" archive HEAD | tar -x -C "$dest"

  local f
  for f in "${PRIVATE_ONLY[@]}"; do rm -f "$dest/$f"; done
  public_seam > "$dest/$SEAM"

  # Backstop. A hit is a bug in the scrub, not something to whitelist away.
  local hits
  hits="$(grep -rilE "$FORBIDDEN" "$dest" || true)"
  if [ -n "$hits" ]; then
    echo >&2
    echo "REFUSING TO EXPORT — client references found in the public tree:" >&2
    echo "$hits" | sed "s|^$dest/|  |" >&2
    echo >&2
    echo "Fix them where they are: they belong upstream, scrubbed." >&2
    exit 1
  fi
  check_invariant "$dest" || { echo "REFUSING TO EXPORT — invariant broken." >&2; exit 1; }

  echo "Exported $(find "$dest" -type f -not -path '*/.git/*' | wc -l | tr -d ' ') files to $dest"
  echo "Invariant holds and no client references found."
}

cmd_check() {
  need_conf
  git -C "$ROOT" remote get-url upstream >/dev/null 2>&1 || {
    echo "no 'upstream' remote — add the public repository first:" >&2
    echo "  git remote add upstream <public repo url>" >&2
    exit 1
  }
  git -C "$ROOT" fetch -q upstream
  local allowed=" ${PRIVATE_ONLY[*]} ${DIVERGES[*]} " drift=() f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$allowed" in *" $f "*) continue ;; esac
    drift+=("$f")
  done < <(git -C "$ROOT" diff --name-only upstream/main...HEAD || true)

  if [ ${#drift[@]} -gt 0 ]; then
    echo "This repository has changed ${#drift[@]} file(s) that belong upstream:" >&2
    printf '  %s\n' "${drift[@]}" >&2
    echo >&2
    echo "Move those changes to the public repository and pull them back, or the" >&2
    echo "next upstream merge will fight you over every one of them." >&2
    exit 1
  fi
  echo "Check: this repository differs from upstream only in its own files."
}

case "${1:-}" in
  guard)  cmd_guard ;;
  list)   cmd_list ;;
  export) shift; cmd_export "$@" ;;
  check)  cmd_check ;;
  *) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
