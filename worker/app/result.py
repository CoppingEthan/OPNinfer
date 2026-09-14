"""Shared handler result contract."""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class HandlerResult:
    # ready | unsupported | failed  (unsupported = stored fine, metadata only)
    status: str
    # Which engine actually prepared it (recorded on the row).
    processor_group: str
    # Markdown content for the .opninfer artifact; None = metadata only.
    content: Optional[str] = None
    # Metadata block — always present in spirit; handlers add what they know.
    meta: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    # True when the failure was TRANSIENT — an engine that was restarting, a
    # timeout, a 5xx. Those must go back on the queue instead of being marked
    # failed for ever: `./deploy.sh` restarts the shared engines stack, so any
    # file mid-transcription at that moment used to die permanently, and the
    # only recovery a user had was noticing the red dot and uploading again.
    retryable: bool = False
    # Set by a handler that wants another group to take over (e.g. a scanned
    # PDF escalating markitdown → docling). The dispatcher follows at most one
    # escalation hop.
    escalate_to: Optional[str] = None
