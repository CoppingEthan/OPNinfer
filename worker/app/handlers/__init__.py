"""Handler registry + dispatch.

Every group named by `detect.route()` maps to a callable
`(path, filename, job) -> HandlerResult`. Groups whose real handler hasn't
shipped yet fall back to the metadata handler (with the intended group noted),
so routing is complete from day one and handlers slot in without rewiring.
"""

from typing import Callable

from ..result import HandlerResult
from . import (
    database,
    docling,
    gotenberg_handler,
    markitdown_handler,
    metadata,
    passthrough,
    spreadsheet,
    video,
    whisper_handler,
)

Handler = Callable[[str, str, object], HandlerResult]

HANDLERS: dict[str, Handler] = {
    "markitdown": markitdown_handler.handle,
    "passthrough": passthrough.handle,
    "image": metadata.handle_image,
    "metadata": metadata.handle,
    "spreadsheet": spreadsheet.handle,
    "database": database.handle,
    "video": video.handle,
    "libreoffice": gotenberg_handler.handle,
    "docling": docling.handle,
    "audio": whisper_handler.handle,
}


def dispatch(group: str, path: str, filename: str, job: object) -> HandlerResult:
    handler = HANDLERS.get(group)
    if handler is None:
        result = metadata.handle(path, filename, job)
        result.meta["intendedGroup"] = group
        return result

    result = handler(path, filename, job)

    # Follow at most ONE escalation hop (markitdown → docling for scanned PDFs).
    if result.escalate_to:
        target = HANDLERS.get(result.escalate_to)
        if target is not None:
            escalated = target(path, filename, job)
            escalated.meta.setdefault("escalatedFrom", result.processor_group)
            return escalated
        fallback = metadata.handle(path, filename, job)
        fallback.meta["intendedGroup"] = result.escalate_to
        fallback.meta.update(result.meta)
        return fallback

    return result
