"""Group 3 — Docling (docling-serve container): OCR + layout-aware extraction
for scanned or complex PDFs. Used by exception — files land here only when
MarkItDown's flat extraction came back empty-handed (dispatcher escalation)."""

import httpx

from .. import config
from ..result import HandlerResult


def handle(path: str, filename: str, job: object) -> HandlerResult:
    if not config.DOCLING_URL:
        return HandlerResult(
            status="unsupported",
            processor_group="docling",
            meta={
                "note": "Looks scanned/image-only; the OCR engine (docling, "
                "compose profile 'heavy') isn't running."
            },
        )

    try:
        with open(path, "rb") as f:
            resp = httpx.post(
                f"{config.DOCLING_URL}/v1/convert/file",
                files={"files": (filename, f, "application/octet-stream")},
                data={"to_formats": "md", "do_ocr": "true"},
                timeout=config.engine_timeout(600),
            )
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPStatusError as e:
        return HandlerResult(
            status="failed",
            processor_group="docling",
            error=f"Docling failed ({e.response.status_code}): {e.response.text[:200]}",
            retryable=e.response.status_code >= 500,
        )
    except Exception as e:  # noqa: BLE001 — engine down/unreachable
        return HandlerResult(
            status="failed",
            processor_group="docling",
            error=f"Docling unreachable: {type(e).__name__}: {e}",
            # The engines stack restarts on every deploy — put it back on the
            # queue rather than losing the file.
            retryable=True,
        )

    status = payload.get("status")
    if status not in ("success", "partial_success"):
        errors = payload.get("errors") or []
        return HandlerResult(
            status="failed",
            processor_group="docling",
            error=f"Docling conversion {status}: {str(errors)[:200]}",
        )

    md = ((payload.get("document") or {}).get("md_content") or "").strip()
    meta: dict = {"ocr": True}
    if payload.get("processing_time"):
        meta["processingSeconds"] = round(float(payload["processing_time"]), 1)
    if not md:
        return HandlerResult(
            status="unsupported",
            processor_group="docling",
            meta={**meta, "note": "OCR found no readable text."},
        )
    return HandlerResult(
        status="ready", processor_group="docling", content=md, meta=meta
    )
