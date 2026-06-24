"""Server-Sent Events wire-format helpers.

All SSE events are JSON objects encoded as:
    data: <JSON>\n\n

The terminal marker is:
    data: [DONE]\n\n

This matches the Node.js sseWriter.ts format exactly so the existing WordPress
plugin client requires no changes.
"""

import json
from typing import Any

SSE_HEADERS: dict[str, str] = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def format_sse(event: dict[str, Any]) -> str:
    """Encode a dict as a single SSE data line."""
    return f"data: {json.dumps(event)}\n\n"


def format_sse_done() -> str:
    return "data: [DONE]\n\n"
