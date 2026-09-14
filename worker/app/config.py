"""Worker configuration — everything comes from the environment."""

import os

from .dburl import libpq_url

# The app and the worker share one DATABASE_URL; Prisma's pool-tuning query
# parameters are stripped here or libpq refuses to connect at all.
DATABASE_URL = libpq_url(os.environ["DATABASE_URL"])

# Shared storage volume (the same tree the Next.js app writes uploads into).
STORAGE_ROOT = os.environ.get("STORAGE_ROOT", "/storage")

# Engine service endpoints. Empty/unset = that engine is unavailable and its
# routes degrade (docling -> metadata-with-note, whisper -> metadata, ...).
GOTENBERG_URL = os.environ.get("GOTENBERG_URL", "").rstrip("/")
DOCLING_URL = os.environ.get("DOCLING_URL", "").rstrip("/")
WHISPER_URL = os.environ.get("WHISPER_URL", "").rstrip("/")

# How many files to process at once. Keep small: heavy engines gate themselves,
# but MarkItDown/pandas run in-process.
CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "2"))

POLL_SECONDS = float(os.environ.get("WORKER_POLL_SECONDS", "2"))

# A `processing` row whose claim is older than this is considered orphaned by a
# crashed worker and gets re-claimed.
#
# It MUST exceed the longest engine call, or a slow job re-claims itself while
# still running: whisper's timeout was 1800s against a 900s window, so a long
# recording (or any file queued behind others on the single shared whisper
# container) was picked up a second time, sent to the engine again — doubling
# the load on the thing that was already the bottleneck — and eventually marked
# failed while a transcription was still in flight. `engine_timeout` below
# enforces the relationship rather than leaving it to be re-broken by hand.
RECLAIM_MINUTES = int(os.environ.get("WORKER_RECLAIM_MINUTES", "35"))


def engine_timeout(preferred: int) -> int:
    """Clamp an engine HTTP timeout to safely inside the reclaim window.

    Five minutes of headroom covers the request setup and the artifact write
    that follow it, so a call that runs to its full timeout still finishes
    before anything else can claim the row.
    """
    ceiling = max(60, RECLAIM_MINUTES * 60 - 300)
    return min(preferred, ceiling)

# Give up on a file after this many attempts.
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))
# Hard wall-clock cap on ONE handler run, in a child process (audit
# 2026-09-05). Kept well under the reclaim window so a hung file is marked
# failed by the thread that owns it, never re-claimed and hung again.
HANDLER_TIMEOUT_SECONDS = int(
    os.environ.get("WORKER_HANDLER_TIMEOUT_SECONDS", str(max(60, RECLAIM_MINUTES * 60 - 600)))
)

# Prepared-content cap (chars) — token efficiency: the model reads the map,
# not a raw dump. ~400k chars ≈ 100k tokens; larger content is truncated with
# a marker and flagged in meta.
MAX_CONTENT_CHARS = int(os.environ.get("WORKER_MAX_CONTENT_CHARS", "400000"))

# Hidden per-pool artifact directory (matches POOL_ARTIFACT_DIR in the app).
ARTIFACT_DIR = ".opninfer"
