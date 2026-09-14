"""Group 4 — audio: transcript via the whisper-asr-webservice container
(faster-whisper engine). The transcript becomes the content block; duration
and language land in metadata."""

import json
import subprocess

import httpx

from .. import config
from ..result import HandlerResult


def _duration_seconds(path: str) -> float | None:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True, timeout=30, check=False,
        )
        return round(float(json.loads(proc.stdout or b"{}").get("format", {}).get("duration", 0)), 2) or None
    except Exception:  # noqa: BLE001
        return None


def handle(path: str, filename: str, job: object) -> HandlerResult:
    meta: dict = {}
    dur = _duration_seconds(path)
    if dur:
        meta["durationSeconds"] = dur

    if not config.WHISPER_URL:
        return HandlerResult(
            status="unsupported",
            processor_group="audio",
            meta={
                **meta,
                "note": "Transcription engine (whisper, compose profile "
                "'heavy') isn't running.",
            },
        )

    try:
        with open(path, "rb") as f:
            resp = httpx.post(
                f"{config.WHISPER_URL}/asr",
                params={"task": "transcribe", "output": "json", "encode": "true"},
                files={"audio_file": (filename, f, "application/octet-stream")},
                # Generous: first request may download the model; long audio
                # transcribes at a fraction of real time on CPU. Clamped to stay
                # inside the reclaim window — see config.engine_timeout.
                timeout=config.engine_timeout(1800),
            )
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPStatusError as e:
        return HandlerResult(
            status="failed", processor_group="audio",
            error=f"Whisper failed ({e.response.status_code}): {e.response.text[:200]}",
            # A 5xx is the engine having a moment; a 4xx is this file.
            retryable=e.response.status_code >= 500,
        )
    except Exception as e:  # noqa: BLE001
        return HandlerResult(
            status="failed", processor_group="audio",
            error=f"Whisper unreachable: {type(e).__name__}: {e}",
            # Engine restarting (every deploy restarts the shared stack), or a
            # timeout — the file goes back on the queue, not in the bin.
            retryable=True,
        )

    text = (payload.get("text") or "").strip()
    if payload.get("language"):
        meta["language"] = payload["language"]
    if not text:
        return HandlerResult(
            status="unsupported",
            processor_group="audio",
            meta={**meta, "note": "No speech detected."},
        )

    content = f"# Transcript: {filename}\n\n{text}"
    return HandlerResult(
        status="ready", processor_group="audio", content=content, meta=meta
    )
