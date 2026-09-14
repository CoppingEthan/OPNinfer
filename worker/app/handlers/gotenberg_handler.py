"""Group 2 — legacy binary Office / OpenDocument / RTF / iWork:
LibreOffice (via the Gotenberg container) normalizes them to PDF, then the
embedded MarkItDown extracts the text from that PDF.

  .doc/.ppt/.odt/.odp/.rtf/.pages/.key → Gotenberg /forms/libreoffice/convert → PDF → MarkItDown
"""

import os
import tempfile

import httpx

from .. import config
from ..result import HandlerResult
from . import markitdown_handler


def handle(path: str, filename: str, job: object) -> HandlerResult:
    if not config.GOTENBERG_URL:
        return HandlerResult(
            status="unsupported",
            processor_group="libreoffice",
            meta={"note": "Legacy-Office conversion engine (Gotenberg) not configured."},
        )

    try:
        with open(path, "rb") as f:
            resp = httpx.post(
                f"{config.GOTENBERG_URL}/forms/libreoffice/convert",
                files={"files": (filename, f, "application/octet-stream")},
                timeout=config.engine_timeout(180),
            )
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        return HandlerResult(
            status="failed",
            processor_group="libreoffice",
            error=f"Gotenberg conversion failed ({e.response.status_code}): "
            f"{e.response.text[:200]}",
        )
    except Exception as e:  # noqa: BLE001 — engine down/unreachable
        return HandlerResult(
            status="failed",
            processor_group="libreoffice",
            error=f"Gotenberg unreachable: {type(e).__name__}: {e}",
            retryable=True,
        )

    # Extract text from the normalized PDF with the embedded MarkItDown.
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(resp.content)
        tmp.close()
        inner = markitdown_handler.handle(tmp.name, f"{filename}.pdf", job)
    finally:
        os.unlink(tmp.name)

    inner.processor_group = "libreoffice"
    inner.meta["convertedVia"] = "gotenberg"
    # A thin-text PDF from a legacy doc means a scanned original; Docling can't
    # read the legacy source directly, so surface it as metadata-only instead
    # of escalating.
    if inner.escalate_to:
        inner.escalate_to = None
        inner.status = "unsupported"
        inner.meta["note"] = "Converted PDF contained no extractable text (scanned original?)."
    return inner
