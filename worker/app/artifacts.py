"""Prepared-content artifacts.

Each pool has a hidden `.opninfer/` directory holding `<fileId>.md` — the
token-efficient content block the model reads via the read_file tool. Artifact
paths (like all storage paths) are stored POSIX-style.
"""

import os
import posixpath

from . import config


def resolve_storage_path(rel: str) -> str:
    """Resolve a DB-relative path against the storage root, guarding traversal.

    Tolerates legacy Windows-dev rows that stored backslash separators.
    """
    rel_posix = rel.replace("\\", "/")
    root = os.path.realpath(config.STORAGE_ROOT)
    lexical = os.path.normpath(os.path.join(root, rel_posix))
    if lexical != root and not lexical.startswith(root + os.sep):
        raise ValueError(f"storage path escapes the root: {rel!r}")
    # No symbolic link anywhere below the root (audit 2026-09-05): the worker
    # runs as root and both reads and WRITES through this path, and the
    # sandbox can plant a link in a pool as the same uid — `notes.txt ->
    # ../<other-chat>/contract.docx` would have been ingested into this
    # chat's artifacts, or an artifact written over whatever a link named.
    # If the real path differs from the lexical one, a link was followed.
    if os.path.lexists(lexical) and os.path.realpath(lexical) != lexical:
        raise ValueError(f"storage path goes through a symbolic link: {rel!r}")
    return lexical


def _match_pool_owner(path: str, pool_abs: str) -> None:
    """Give `path` the same owner as its chat pool.

    The worker container runs as root; the app runs as `node` (uid 1000) and
    owns every pool directory. Without this the hidden `.opninfer/` artifacts
    land as root:root, and deleting a chat later fails part-way through —
    the uploads go, the artifacts and the pool directory stay behind forever
    (the app's rm is best-effort and swallows the permission error).

    Best-effort by design: on a non-root worker, or a Windows dev bind mount,
    chown isn't permitted or meaningful and the artifact is still written.
    """
    try:
        owner = os.stat(pool_abs)
        os.chown(path, owner.st_uid, owner.st_gid)
    except (OSError, AttributeError):
        # AttributeError: os.chown doesn't exist on Windows.
        pass


def write_content_artifact(storage_path: str, file_id: str, content: str) -> tuple[str, bool]:
    """Write the prepared markdown next to the file's pool, capped for token
    sanity. Returns (relative artifact path, truncated?)."""
    truncated = False
    if len(content) > config.MAX_CONTENT_CHARS:
        content = (
            content[: config.MAX_CONTENT_CHARS]
            + "\n\n[… truncated: file content exceeds the prepared-content cap. "
            "The full file is available at its storage path.]"
        )
        truncated = True

    pool_rel = posixpath.dirname(storage_path.replace("\\", "/"))
    artifact_rel = posixpath.join(pool_rel, config.ARTIFACT_DIR, f"{file_id}.md")
    artifact_abs = resolve_storage_path(artifact_rel)
    artifact_dir = os.path.dirname(artifact_abs)
    pool_abs = os.path.dirname(artifact_dir)
    os.makedirs(artifact_dir, exist_ok=True)
    _match_pool_owner(artifact_dir, pool_abs)
    with open(artifact_abs, "w", encoding="utf-8") as f:
        f.write(content)
    _match_pool_owner(artifact_abs, pool_abs)
    return artifact_rel, truncated
