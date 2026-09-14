#!/bin/sh
# Keep the Claude sign-in shared between chats (sandboxd runs this inside the
# agent container at start and after every run — see index.mjs).
#
# The sign-in lives in the shared volume (~/.claude-shared) and is SYMLINKED
# into the chat's config dir. When the plan's access token expires the CLI
# refreshes it and writes the new pair back — a write that goes through a
# temp file + rename replaces the symlink with a regular file in the chat's
# own state dir. Left there, the refreshed token dies with the chat while
# the shared copy keeps the OLD refresh token, which Anthropic has rotated:
# the next chat's refresh fails ("OAuth session expired and could not be
# refreshed") and every run fails over. Found live 2026-09-02.
#
# So: a regular file newer than the shared copy is copied back to the volume
# first, then the symlink is (re)made. Two chats refreshing at once are
# last-writer-wins; the loser's next refresh fails once and fails over.
#
# Only a file that IS a Claude credentials JSON is ever copied back
# (2026-09-04): a backup-restore had turned every chat's symlink into a
# 60-byte regular file holding the link TARGET as text, and had those been
# newer than the shared copy this would have written that text over the
# sign-in. A refreshed pair always carries "claudeAiOauth"; anything else is
# discarded and re-linked.
S=/home/sandbox/.claude-shared/.credentials.json
L=/home/sandbox/.claude/.credentials.json
mkdir -p /home/sandbox/.claude
if [ -f "$L" ] && [ ! -L "$L" ]; then
  # Both tokens must be non-empty, not merely present. A FAILED refresh
  # rewrites this file with every field there and the two tokens BLANKED
  # (538 bytes -> 290, reproduced 2026-09-07), which the old
  # "does it contain claudeAiOauth" check happily accepted — so the container
  # that lost a refresh race would wipe the shared sign-in for every other
  # chat, turning a transient failure into one that needs the login run again.
  if grep -q '"accessToken":"[^"]' "$L" 2>/dev/null && grep -q '"refreshToken":"[^"]' "$L" 2>/dev/null; then
    # In a chat container the shared volume is READ-ONLY (2026-09-05): the
    # broker has already copied this file back (captureRefreshedCredential)
    # before running us, so only a writable share — the standalone test's
    # scratch dir — is copied to here.
    if [ -w "$S" ] || { [ ! -e "$S" ] && [ -w "$(dirname "$S")" ]; }; then
      if [ ! -f "$S" ] || [ "$L" -nt "$S" ]; then
        cp -p "$L" "$S" && echo "synced-back"
      fi
    else
      echo "shared-read-only (broker synced it)"
    fi
  else
    echo "discarded-non-credentials"
  fi
  rm -f "$L"
fi
ln -sfn "$S" "$L"
