"""
Request-scoped context for an agent invocation.

The same cluster of per-request values (the authenticated user, the target
WordPress site, its MCP endpoint, the decrypted WP credentials, and the optional
LangFuse handler) flows through the whole chat path:

    chat_stream → build_contextual_tools → InvokeSpecialistTool
    chat_stream → SingleAgentGraph.stream → _stream_graph
                                          → generate → _invoke_graph

Bundling them into one frozen object keeps those signatures small and makes the
data that travels with a request explicit rather than threaded as loose args.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RequestContext:
    """Immutable per-request credentials and routing context for an agent call."""

    user_id: str
    mcp_endpoint: str
    site_url: str
    cred_username: str
    cred_app_password: str
    langfuse_handler: object | None = None
