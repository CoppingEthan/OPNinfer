"""UTF-8 passthrough — the catch-all for code, config, and every plain-text
format under the sun. The content IS the file; no conversion needed."""

from ..result import HandlerResult


def handle(path: str, filename: str, job: object) -> HandlerResult:
    try:
        with open(path, "r", encoding="utf-8", errors="strict") as f:
            text = f.read()
    except UnicodeDecodeError:
        return HandlerResult(
            status="unsupported",
            processor_group="passthrough",
            meta={"note": "Not valid UTF-8 after all."},
        )
    except OSError as e:
        return HandlerResult(
            status="failed", processor_group="passthrough", error=str(e)
        )

    lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
    return HandlerResult(
        status="ready",
        processor_group="passthrough",
        content=text,
        meta={"lines": lines, "chars": len(text)},
    )
