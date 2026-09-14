"""Group 5 — video: ffprobe metadata only, by design. Duration, container,
resolution, frame rate, codecs, bitrate, audio-track presence. No frames, no
transcription."""

import json
import subprocess

from ..result import HandlerResult


def handle(path: str, filename: str, job: object) -> HandlerResult:
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", "-show_streams", path,
            ],
            capture_output=True,
            timeout=60,
            check=False,
        )
        info = json.loads(proc.stdout or b"{}")
    except Exception as e:  # noqa: BLE001 — ffprobe missing/crashed
        return HandlerResult(
            status="failed", processor_group="video",
            error=f"ffprobe failed: {type(e).__name__}: {e}",
        )

    fmt = info.get("format", {}) or {}
    streams = info.get("streams", []) or []
    if not fmt and not streams:
        return HandlerResult(
            status="unsupported",
            processor_group="video",
            meta={"note": "ffprobe could not parse this file."},
        )

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    meta: dict = {
        "container": fmt.get("format_name"),
        "durationSeconds": round(float(fmt.get("duration", 0) or 0), 2),
        "bitRate": int(fmt.get("bit_rate", 0) or 0),
        "hasAudio": audio is not None,
    }
    if video:
        meta["width"] = video.get("width")
        meta["height"] = video.get("height")
        meta["videoCodec"] = video.get("codec_name")
        rate = video.get("avg_frame_rate") or "0/1"
        try:
            num, den = rate.split("/")
            meta["fps"] = round(int(num) / int(den), 2) if int(den) else None
        except (ValueError, ZeroDivisionError):
            pass
        if video.get("nb_frames"):
            meta["frames"] = int(video["nb_frames"])
    if audio:
        meta["audioCodec"] = audio.get("codec_name")

    # Metadata IS the intended preparation for video → ready, empty content.
    return HandlerResult(status="ready", processor_group="video", meta=meta)
