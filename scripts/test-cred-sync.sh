#!/usr/bin/env bash
# Deterministic test for sandboxd/cred-sync.sh — the script that keeps the
# Claude sign-in shared between chats (2026-09-02, found live: a refreshed
# OAuth token was stranded in one chat's state dir and the shared refresh
# token, rotated by Anthropic, then failed for every later chat).
#
#   bash scripts/test-cred-sync.sh
#
# Runs the EXACT file the broker runs, inside the agent image, against fake
# credential files (no real sign-in touched — the shared volume is not
# mounted; a scratch dir stands in for it).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${AGENT_IMAGE:-opninfer-agent}"
SCRIPT="$(cat sandboxd/cred-sync.sh)"
fails=0
pass() { echo "OK   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }

run_case() {
  # $1 = case label, $2 = setup shell, $3 = assertion shell (exit 0 = pass)
  local label="$1" setup="$2" assert="$3"
  # Each case: fresh scratch dirs standing in for ~/.claude-shared and ~/.claude.
  # The script travels as an env var, not a bind mount: Git Bash on Windows
  # rewrites "/cred-sync.sh" mount targets into C:/Program Files/Git/... and
  # the container then finds nothing. Same bytes either way.
  if docker run --rm -e "CRED_SYNC=$SCRIPT" "$IMAGE" sh -c "
    set -e
    printf '%s\n' \"\$CRED_SYNC\" > /tmp/cred-sync.sh
    rm -rf /home/sandbox/.claude-shared /home/sandbox/.claude
    mkdir -p /home/sandbox/.claude-shared /home/sandbox/.claude
    $setup
    sh /tmp/cred-sync.sh >/tmp/out 2>&1 || { echo 'script failed:'; cat /tmp/out; exit 1; }
    $assert
  " >/tmp/cred-sync-case.log 2>&1; then
    pass "$label"
  else
    fail "$label"
    sed 's/^/     /' /tmp/cred-sync-case.log | head -12
  fi
}

# 1. Fresh container: only the shared file exists → a symlink is made.
run_case "fresh start: symlink made to the shared sign-in" \
  "echo old > /home/sandbox/.claude-shared/.credentials.json" \
  "[ -L /home/sandbox/.claude/.credentials.json ] && [ \"\$(cat /home/sandbox/.claude/.credentials.json)\" = old ]"

# 2. THE BUG: the CLI refreshed and left a NEWER regular file in the chat dir.
#    It must be copied back to the shared volume and re-linked.
run_case "refreshed token (regular file, newer) is copied back and re-linked" \
  "echo old > /home/sandbox/.claude-shared/.credentials.json; sleep 1; echo '{\"claudeAiOauth\":{\"accessToken\":\"refreshed\",\"refreshToken\":\"rt-new\"}}' > /home/sandbox/.claude/.credentials.json" \
  "grep -q refreshed /home/sandbox/.claude-shared/.credentials.json && [ -L /home/sandbox/.claude/.credentials.json ] && grep -q synced-back /tmp/out"

# 2b. A NEWER regular file that is NOT a credentials JSON — what a backup
#     restore left in every chat dir on 2026-09-04 (the symlink's target path
#     as text) — must never be copied over the sign-in.
run_case "a newer non-credentials file (restored link-as-text) is discarded, sign-in kept" \
  "echo '{\"claudeAiOauth\":{\"accessToken\":\"real\",\"refreshToken\":\"rt-real\"}}' > /home/sandbox/.claude-shared/.credentials.json; sleep 1; echo '../../../../../home/sandbox/.claude-shared/.credentials.json' > /home/sandbox/.claude/.credentials.json" \
  "grep -q real /home/sandbox/.claude-shared/.credentials.json && [ -L /home/sandbox/.claude/.credentials.json ] && ! grep -q synced-back /tmp/out && grep -q discarded /tmp/out"

# 2c. THE STICKY SIGN-OUT (found live, 2026-09-07). When a refresh FAILS —
#     which is what happens to whichever container lost the race after
#     Anthropic rotated the refresh token — the CLI does not leave the file
#     alone: it rewrites it with every field present and both tokens BLANKED
#     (538 bytes -> 290, reproduced in the agent image). The old "does it
#     contain claudeAiOauth" check accepted that, so one unlucky chat wiped
#     the instance's sign-in for everybody and only a fresh login fixed it.
run_case "a blanked credential from a FAILED refresh never overwrites the sign-in"   "echo '{\"claudeAiOauth\":{\"accessToken\":\"real\",\"refreshToken\":\"rt-real\"}}' > /home/sandbox/.claude-shared/.credentials.json; sleep 1; echo '{\"claudeAiOauth\":{\"accessToken\":\"\",\"refreshToken\":\"\",\"expiresAt\":0,\"scopes\":[],\"subscriptionType\":\"max\"}}' > /home/sandbox/.claude/.credentials.json"   "grep -q rt-real /home/sandbox/.claude-shared/.credentials.json && [ -L /home/sandbox/.claude/.credentials.json ] && ! grep -q synced-back /tmp/out"

# 2d. An access token with no refresh token is not a sign-in worth keeping:
#     it dies within hours and cannot renew itself, so accepting it would
#     replace one outage with a slower one.
run_case "a credential with no refresh token is not synced back"   "echo '{\"claudeAiOauth\":{\"accessToken\":\"real\",\"refreshToken\":\"rt-real\"}}' > /home/sandbox/.claude-shared/.credentials.json; sleep 1; echo '{\"claudeAiOauth\":{\"accessToken\":\"only-this\"}}' > /home/sandbox/.claude/.credentials.json"   "grep -q rt-real /home/sandbox/.claude-shared/.credentials.json && ! grep -q synced-back /tmp/out"

# 3. An OLDER stray regular file must NOT clobber a newer shared sign-in.
run_case "an older stray file does not overwrite a newer shared sign-in" \
  "echo stale > /home/sandbox/.claude/.credentials.json; sleep 1; echo newer > /home/sandbox/.claude-shared/.credentials.json" \
  "[ \"\$(cat /home/sandbox/.claude-shared/.credentials.json)\" = newer ] && [ -L /home/sandbox/.claude/.credentials.json ] && ! grep -q synced-back /tmp/out"

# 4. Already a symlink: nothing copied, link kept.
run_case "an existing symlink is left alone (no copy)" \
  "echo shared > /home/sandbox/.claude-shared/.credentials.json; ln -s /home/sandbox/.claude-shared/.credentials.json /home/sandbox/.claude/.credentials.json" \
  "[ -L /home/sandbox/.claude/.credentials.json ] && ! grep -q synced-back /tmp/out"

# 5. No sign-in anywhere yet (fresh install): the link is still made so a
#    later login through the shared volume appears without a restart.
run_case "no sign-in at all: dangling link made, no error" \
  "true" \
  "[ -L /home/sandbox/.claude/.credentials.json ]"

# 6. The broker really does read this file (no copy to drift).
if grep -q 'readFileSync(new URL("./cred-sync.sh", import.meta.url)' sandboxd/index.mjs && grep -q "COPY.*cred-sync.sh\|COPY \. \.\|COPY \./ \./\|COPY \* " sandboxd/Dockerfile; then
  pass "sandboxd reads cred-sync.sh and its Dockerfile ships it"
else
  fail "sandboxd does not read/ship cred-sync.sh"
fi

# 7. The BROKER applies the same rule. It is the half that actually runs in
#    production (the shared volume is read-only inside a chat container, so
#    the container-side script above only ever reports), and it is checked
#    here against the real module rather than by reading index.mjs.
if node --input-type=module -e "
  import { isUsableCredential } from './sandboxd/credentials.mjs';
  const good = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } };
  const blanked = { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } };
  const partial = { claudeAiOauth: { accessToken: 'a' } };
  const ok = isUsableCredential(good)
    && !isUsableCredential(blanked)
    && !isUsableCredential(partial)
    && !isUsableCredential({})
    && !isUsableCredential(null);
  process.exit(ok ? 0 : 1);
"; then
  pass "the broker refuses a blanked credential and keeps the shared sign-in"
else
  fail "the broker would sync a blanked credential back"
fi
if grep -q 'isUsableCredential' sandboxd/index.mjs; then
  pass "sandboxd's sync-back actually calls that check"
else
  fail "sandboxd does not use isUsableCredential"
fi
# …and the image must SHIP it. The Dockerfile copies broker files by name, so
# a new module that resolves perfectly in dev is simply absent in production
# and takes the whole broker down at boot — the same class as CHANGELOG.md
# missing from the app image, with a much louder failure.
missing=""
for f in $(grep -oE '"\./[a-z-]+\.mjs"' sandboxd/index.mjs | tr -d '"' | sed 's|^\./||' | sort -u); do
  grep -qE "^COPY .*$f" sandboxd/Dockerfile || missing="$missing $f"
done
if [ -z "$missing" ]; then
  pass "every module sandboxd imports is COPYed into its image"
else
  fail "sandboxd's Dockerfile does not ship:$missing"
fi

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; exit 1; fi
