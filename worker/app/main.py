"""OPNinfer ingestion worker — main loop.

N threads each: claim a pending file (FOR UPDATE SKIP LOCKED) → detect its
real type → dispatch to the right handler → write the prepared artifact →
record the outcome. Every failure path degrades gracefully; the queue is the
`files` table, so restarts lose nothing.
"""

import multiprocessing
import os
import threading
import time
import traceback

import psycopg

from . import artifacts, config, db, detect
from .handlers import dispatch
from .result import HandlerResult


def _dispatch_in_child(q: "multiprocessing.Queue", group: str, path: str, filename: str, job: db.Job) -> None:
    try:
        q.put(("ok", dispatch(group, path, filename, job)))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        q.put(("err", f"{type(e).__name__}: {e}"))


def dispatch_bounded(group: str, path: str, filename: str, job: db.Job) -> HandlerResult:
    """Run the handler in a child process under a hard wall-clock cap.

    In-process handlers had no timeout and no memory bound (audit
    2026-09-05): a crafted PDF or nested archive could hang a worker thread
    for ever, the row would be reclaimed after the 35-minute window and hang
    the OTHER thread the same way, and ingestion for the whole instance would
    stop with no error row, no alert, and the deploy check still green. In a
    child the same file times out (`WORKER_HANDLER_TIMEOUT_SECONDS`, below
    the reclaim window) or dies of memory ALONE, and the row is marked failed
    — never retried, never blocking anyone else.
    """
    ctx = multiprocessing.get_context("fork") if hasattr(os, "fork") else multiprocessing.get_context("spawn")
    q: "multiprocessing.Queue" = ctx.Queue(maxsize=1)
    child = ctx.Process(target=_dispatch_in_child, args=(q, group, path, filename, job), daemon=True)
    child.start()
    child.join(config.HANDLER_TIMEOUT_SECONDS)
    if child.is_alive():
        child.terminate()
        child.join(10)
        if child.is_alive():
            child.kill()
        return HandlerResult(
            status="failed",
            processor_group=group,
            error=f"Processing timed out after {config.HANDLER_TIMEOUT_SECONDS}s.",
        )
    try:
        kind, payload = q.get(timeout=5)
    except Exception:  # noqa: BLE001 — the child died without reporting (OOM-killed)
        return HandlerResult(
            status="failed",
            processor_group=group,
            error=f"Processing crashed (exit {child.exitcode}) — possibly out of memory.",
        )
    if kind == "ok":
        return payload
    return HandlerResult(status="failed", processor_group=group, error=str(payload))


def process(conn: psycopg.Connection, job: db.Job) -> None:
    print(f"[worker] {job.id} {job.filename!r} (attempt {job.attempts})")

    if job.attempts > config.MAX_ATTEMPTS:
        db.finish(
            conn, job.id, status="failed",
            error=f"Gave up after {config.MAX_ATTEMPTS} attempts.",
        )
        return

    try:
        path = artifacts.resolve_storage_path(job.storage_path)
    except ValueError as e:
        db.finish(conn, job.id, status="failed", error=str(e))
        return
    if not os.path.isfile(path):
        db.finish(conn, job.id, status="failed", error="File missing from storage.")
        return

    # `detect.route` is inside the try for the same reason `dispatch` is: an
    # exception escaping `process()` leaves the row claimed, so it sits
    # `processing` for the whole reclaim window, is re-claimed, fails the same
    # way, and only reaches a terminal state attempts-many windows later — long
    # after the chat gave up waiting for it. Nothing here may throw.
    group = "unknown"
    try:
        group, detected_mime = detect.route(path, job.filename, job.declared_mime)
        result = dispatch_bounded(group, path, job.filename, job)
    except Exception as e:  # noqa: BLE001 — a handler bug must not kill the row
        traceback.print_exc()
        detected_mime = job.declared_mime
        result = HandlerResult(
            status="failed", processor_group=group, error=f"{type(e).__name__}: {e}"
        )

    content_path = None
    token_estimate = None
    if result.content is not None:
        try:
            content_path, truncated = artifacts.write_content_artifact(
                job.storage_path, job.id, result.content
            )
            if truncated:
                result.meta["truncated"] = True
            token_estimate = min(len(result.content), config.MAX_CONTENT_CHARS) // 4
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            result.status = "failed"
            result.error = f"Artifact write failed: {e}"

    # A transient failure (engine restarting, timeout, 5xx) goes back on the
    # queue while attempts remain. `failed` is for things that will fail again.
    if result.status == "failed" and result.retryable and job.attempts < config.MAX_ATTEMPTS:
        db.requeue(conn, job.id, result.error or "Transient failure — will retry.")
        print(f"[worker] {job.id} → requeued (attempt {job.attempts}): {result.error}")
        return

    try:
        db.finish(
            conn,
            job.id,
            status=result.status,
            detected_mime=detected_mime,
            processor_group=result.processor_group,
            content_path=content_path,
            meta=result.meta or None,
            token_estimate=token_estimate,
            error=result.error,
        )
    except Exception as e:  # noqa: BLE001
        # Most likely the metadata: Postgres `jsonb` cannot hold a NUL byte, and
        # a spreadsheet header or SQLite table name containing one produces JSON
        # that serialises fine and is rejected on the cast. Land the row in a
        # terminal state anyway — a file stuck `processing` is worse than one
        # recorded without its metadata.
        traceback.print_exc()
        db.finish(
            conn,
            job.id,
            status=result.status,
            detected_mime=detected_mime,
            processor_group=result.processor_group,
            content_path=content_path,
            meta=None,
            token_estimate=token_estimate,
            error=(result.error or "") + f" [metadata dropped: {type(e).__name__}]",
        )
    print(f"[worker] {job.id} → {result.status} ({result.processor_group})")


HEALTH_FILE = "/tmp/opninfer-worker-db-ok"


def _mark_health(ok: bool) -> None:
    try:
        if ok:
            with open(HEALTH_FILE, "w", encoding="utf-8") as f:
                f.write(str(int(time.time())))
        elif os.path.exists(HEALTH_FILE):
            os.remove(HEALTH_FILE)
    except OSError:
        pass


def worker_loop(index: int) -> None:
    conn: psycopg.Connection | None = None
    while True:
        try:
            if conn is None or conn.closed:
                conn = db.connect()
                print(f"[worker#{index}] connected to database")
                # Health marker for the compose healthcheck (audit 2026-09-05):
                # the deploy used to grep the last 200 log lines for this
                # message, which scrolls away after ~100 files.
                _mark_health(True)
            job = db.claim(conn)
            if job is None:
                time.sleep(config.POLL_SECONDS)
                continue
            process(conn, job)
        except Exception as e:  # noqa: BLE001 — reconnect-and-carry-on loop
            print(f"[worker#{index}] loop error: {e}")
            _mark_health(False)
            try:
                if conn is not None:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            time.sleep(5)


def main() -> None:
    print(
        f"[worker] starting: concurrency={config.CONCURRENCY} "
        f"storage={config.STORAGE_ROOT} "
        f"gotenberg={'yes' if config.GOTENBERG_URL else 'no'} "
        f"docling={'yes' if config.DOCLING_URL else 'no'} "
        f"whisper={'yes' if config.WHISPER_URL else 'no'}"
    )
    threads = [
        threading.Thread(target=worker_loop, args=(i,), daemon=True)
        for i in range(config.CONCURRENCY)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
