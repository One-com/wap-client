"""Shared text extraction utility for LangChain message content."""

from __future__ import annotations


def extract_text(content: object) -> str:
    """Extract plain text from a LangChain message content value.

    Handles both string content and the list-of-blocks format used by
    Anthropic's multi-content messages (text + tool_use blocks).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") if isinstance(b, dict) else str(b)
            for b in content
            if not isinstance(b, dict) or b.get("type") == "text"
        )
    return str(content)
