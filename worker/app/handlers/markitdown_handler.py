"""Group 1 — MarkItDown (embedded): modern Office, PDF-with-text, markup,
ebooks, email, zip. Fast, no models.

PDFs that come back with almost no text are scanned/image-only — those
escalate to Docling (Group 3) via the dispatcher.
"""

import os

from markitdown import MarkItDown

from ..detect import ext_of
from ..result import HandlerResult

# Lazy singleton — MarkItDown wires up its converters once.
_md: MarkItDown | None = None

# "Scanned PDF" heuristic: thin extracted text alone isn't enough (a one-line
# memo is legitimately short) — the file must ALSO be image-heavy-large.
PDF_THIN_TEXT_CHARS = 200
PDF_SCANNED_MIN_BYTES = 50_000


def _engine() -> MarkItDown:
    global _md
    if _md is None:
        _md = MarkItDown(enable_plugins=False)
    return _md


def handle(path: str, filename: str, job: object) -> HandlerResult:
    try:
        converted = _engine().convert(path)
    except Exception as e:  # noqa: BLE001 — any converter failure = this file
        return HandlerResult(
            status="failed",
            processor_group="markitdown",
            error=f"MarkItDown conversion failed: {e}",
        )

    text = (converted.text_content or "").strip()
    meta: dict = {}
    title = getattr(converted, "title", None)
    if title:
        meta["title"] = title

    if (
        ext_of(filename) == "pdf"
        and len(text) < PDF_THIN_TEXT_CHARS
        and os.path.getsize(path) > PDF_SCANNED_MIN_BYTES
    ):
        # Barely any text in a big PDF = scanned/image-only — OCR engine.
        return HandlerResult(
            status="unsupported",
            processor_group="markitdown",
            meta={**meta, "thinText": True, "extractedChars": len(text)},
            escalate_to="docling",
        )

    if not text:
        return HandlerResult(
            status="unsupported",
            processor_group="markitdown",
            meta={**meta, "note": "No extractable text."},
        )

    return HandlerResult(
        status="ready",
        processor_group="markitdown",
        content=text,
        meta=meta,
    )
