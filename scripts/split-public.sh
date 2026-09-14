#!/usr/bin/env bash
#
# The ONE definition of what belongs to this private deployment and not to the
# public OPNinfer product — and the checks that keep the two honest.
#
# The split is deliberately tiny, and it is meant to stay that way. The public
# repository is upstream: it holds the product. This repository is a downstream
# clone that pulls from it and ADDS client capabilities. New files never
# conflict on a merge, which is the whole reason the seam was built the way it
# was (see src/lib/capabilities/local.ts). If this list ever starts growing,
# something has been put in the wrong repository.
#
#   ./scripts/split-public.sh list            what is private, and why
#   ./scripts/split-public.sh export <dir>    build the public tree from HEAD
#   ./scripts/split-public.sh guard           fail if anything private is here
#                                             (for the PUBLIC repo's CI)
#   ./scripts/split-public.sh check           fail if this repo has drifted from
#                                             upstream outside the allowed files
#
set -euo pipefail

# Files that exist ONLY here. Absent from the public tree entirely.
PRIVATE_ONLY=(
  "OPERATIONS.md"                                     # this deployment's own log
  "src/lib/capabilities/property-listings.ts"         # the client capability
  "src/lib/capabilities/dezrez-snapshot.ts"           # its data adapter
  "src/lib/capabilities/dezrez-snapshot.test.ts"
  "src/lib/capabilities/dezrez-fixture.json"          # REAL client stock records
  "scripts/test-capabilities.ts"                      # hits the client's live feed
)

# Files that exist in both but are allowed to differ. Keep this list at ONE
# entry: every extra one is a merge conflict waiting to happen, for ever.
DIVERGES=(
  "src/lib/capabilities/local.ts"                     # empty upstream; wired here
)

# Strings that must not appear anywhere in the exported tree. This is the
# backstop, not the plan — the plan is that the scrub already happened in the
# shared files. A hit here means something client-specific was written into a
# file that goes upstream.
FORBIDDEN='dbwd|satchells|crannull|pandr|dezrez|property_listings|chat\.dbwd|ai\.satchells|ai\.crannull|10\.31\.0\.10'

# The public tree's version of the seam file.
public_local_ts() {
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

cmd_list() {
  echo "Private to this deployment (absent from the public tree):"
  for f in "${PRIVATE_ONLY[@]}"; do
    printf '  %-48s %s\n' "$f" "$([ -e "$f" ] && echo "present" || echo "MISSING")"
  done
  echo
  echo "Present in both, allowed to differ:"
  for f in "${DIVERGES[@]}"; do printf '  %s\n' "$f"; done
  echo
  echo "Everything else must be byte-identical to upstream."
}

cmd_export() {
  local dest="${1:?usage: split-public.sh export <dir>}"
  [ -e "$dest" ] && { echo "refusing to write into an existing path: $dest" >&2; exit 1; }
  mkdir -p "$dest"

  # From HEAD, not the working tree: an export must be reproducible, and must
  # never pick up a file someone forgot to commit.
  git archive HEAD | tar -x -C "$dest"

  for f in "${PRIVATE_ONLY[@]}"; do rm -f "$dest/$f"; done
  public_local_ts > "$dest/src/lib/capabilities/local.ts"

  # Backstop. Any hit is a bug in the scrub, not something to whitelist away.
  # This script is the one exception, for the obvious reason: the list of
  # forbidden strings is IN it.
  local hits
  hits="$(grep -rilE "$FORBIDDEN" "$dest" | grep -v 'scripts/split-public\.sh$' || true)"
  if [ -n "$hits" ]; then
    echo >&2
    echo "REFUSING TO EXPORT — client references found in the public tree:" >&2
    echo "$hits" | sed "s|^$dest/|  |" >&2
    echo >&2
    echo "Fix them in this repository (they belong upstream scrubbed), not here." >&2
    exit 1
  fi

  echo "Exported $(find "$dest" -type f -not -path '*/.git/*' | wc -l | tr -d ' ') files to $dest"
  echo "No client references found. Review it, then create the public repo from it."
}

cmd_guard() {
  local found=()
  for f in "${PRIVATE_ONLY[@]}"; do [ -e "$f" ] && found+=("$f"); done
  if [ ${#found[@]} -gt 0 ]; then
    echo "This is the PUBLIC repository and it contains files that must never reach it:" >&2
    printf '  %s\n' "${found[@]}" >&2
    exit 1
  fi
  local hits
  hits="$(git ls-files -z | xargs -0 grep -rilE "$FORBIDDEN" 2>/dev/null \
          | grep -v 'scripts/split-public\.sh$' || true)"
  if [ -n "$hits" ]; then
    echo "Client references found in the public repository:" >&2
    echo "$hits" | sed 's/^/  /' >&2
    exit 1
  fi
  echo "Public guard: clean."
}

cmd_check() {
  git remote get-url upstream >/dev/null 2>&1 || {
    echo "no 'upstream' remote — add the public repo first:" >&2
    echo "  git remote add upstream <public repo url>" >&2
    exit 1
  }
  git fetch -q upstream
  local allowed drift=()
  allowed=" ${PRIVATE_ONLY[*]} ${DIVERGES[*]} "
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$allowed" in *" $f "*) continue ;; esac
    drift+=("$f")
  done < <(git diff --name-only upstream/main...HEAD || true)

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
  list)   cmd_list ;;
  export) shift; cmd_export "$@" ;;
  guard)  cmd_guard ;;
  check)  cmd_check ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
