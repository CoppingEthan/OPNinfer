"""Queue access — the `files` table IS the queue.

Rows are claimed with `FOR UPDATE SKIP LOCKED`, so any number of worker
threads/processes cooperate without a broker, claims survive restarts, and a
crashed worker's rows are re-claimed after a staleness window.
"""

import json
from dataclasses import dataclass
from typing import Any, Optional

import psycopg

from . import config


@dataclass
class Job:
    id: str
    filename: str
    declared_mime: str
    size_bytes: int
    storage_path: str
    conversation_id: Optional[str]
    attempts: int


def connect() -> psycopg.Connection:
    return psycopg.connect(config.DATABASE_URL, autocommit=True)


CLAIM_SQL = f"""
WITH next AS (
  SELECT id FROM files
  WHERE status = 'pending'
     OR (status = 'processing'
         AND claimed_at < now() - interval '{config.RECLAIM_MINUTES} minutes')
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE files f
SET status = 'processing', claimed_at = now(), attempts = f.attempts + 1
FROM next
WHERE f.id = next.id
RETURNING f.id, f.filename, f.mime_type, f.size_bytes, f.storage_path,
          f.conversation_id, f.attempts
"""


def claim(conn: psycopg.Connection) -> Optional[Job]:
    with conn.cursor() as cur:
        cur.execute(CLAIM_SQL)  # type: ignore[arg-type]
        row = cur.fetchone()
    if row is None:
        return None
    return Job(
        id=str(row[0]),
        filename=row[1],
        declared_mime=row[2],
        size_bytes=int(row[3]),
        storage_path=row[4],
        conversation_id=str(row[5]) if row[5] else None,
        attempts=int(row[6]),
    )


def requeue(conn: psycopg.Connection, file_id: str, error: str) -> None:
    """Put a row back on the queue after a TRANSIENT failure.

    Only touches a row we still hold (`status = 'processing'`), so a file the
    app has re-marked pending in the meantime is left alone.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE files
            SET status = 'pending', claimed_at = NULL, error = %s
            WHERE id = %s AND status = 'processing'
            """,
            (error, file_id),
        )


def finish(
    conn: psycopg.Connection,
    file_id: str,
    *,
    # NB the UPDATE below is guarded on `status = 'processing'`. Without it, a
    # file the app re-marked `pending` while we were working on it (write_file
    # → markFileDirty, which happens constantly when a model iterates on a
    # script) got stamped `ready` with the artifact built from the OLD contents
    # — and, being `ready`, was never re-ingested, so the manifest and read_file
    # served superseded text for the rest of the conversation.
    status: str,
    detected_mime: Optional[str] = None,
    processor_group: Optional[str] = None,
    content_path: Optional[str] = None,
    meta: Optional[dict[str, Any]] = None,
    token_estimate: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE files
            SET status = %s, detected_mime = %s, processor_group = %s,
                content_path = %s, meta = %s::jsonb, token_estimate = %s,
                error = %s, claimed_at = NULL
            WHERE id = %s AND status = 'processing'
            """,
            (
                status,
                detected_mime,
                processor_group,
                content_path,
                json.dumps(meta) if meta is not None else None,
                token_estimate,
                error,
                file_id,
            ),
        )
