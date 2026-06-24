"""
WordPress MCP connection service.

Creates a per-request connection to the WordPress MCP adapter using Basic auth
(WP Application Password).  The connection stays open for the duration of all
tool calls, then is closed automatically when the async context manager exits.

SSRF guard: in production the MCP endpoint must share a hostname with siteUrl
and must not be a private/loopback address.  DEV_BYPASS_LICENSE skips all
validation — NEVER use in production.
"""

from __future__ import annotations

import base64
import ipaddress
import logging
import socket
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from app.config import Settings

if TYPE_CHECKING:
    from langchain_mcp_adapters.client import MultiServerMCPClient

logger = logging.getLogger(__name__)

DEFAULT_MCP_PATH = "/wp-json/mcp/mcp-adapter-default-server"


def _is_private(hostname: str) -> bool:
    """Return True for loopback, private, link-local, or reserved addresses.

    Resolves the hostname to an IP address first so that DNS rebinding and
    IPv6 variants (::1, ::ffff:127.0.0.1, fe80::) are all caught.
    """
    try:
        addr = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            resolved = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
            addr = ipaddress.ip_address(resolved[0][4][0])
        except Exception:  # pylint: disable=broad-exception-caught
            return True  # fail closed: can't resolve → treat as private
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved


class WpConnectionService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _validate_endpoint(self, mcp_endpoint: str, site_url: str) -> None:
        if self._settings.DEV_BYPASS_LICENSE:
            logger.warning(
                "[WpConnectionService] DEV_BYPASS_LICENSE — skipping SSRF validation for %s",
                mcp_endpoint,
            )
            return

        mcp_parsed = urlparse(mcp_endpoint)
        site_parsed = urlparse(site_url)

        if mcp_parsed.hostname != site_parsed.hostname:
            raise ValueError(
                f"MCP endpoint hostname ({mcp_parsed.hostname}) does not match site URL ({site_parsed.hostname})"
            )

        if _is_private(mcp_parsed.hostname or ""):
            raise ValueError(f"MCP endpoint resolves to a private/loopback address: {mcp_parsed.hostname}")

    def mcp_tools_context(
        self,
        mcp_endpoint: str,
        site_url: str,
        username: str,
        app_password: str,
    ) -> "_McpToolsContext":
        """
        Returns an async context manager that yields a list of LangChain tools.

        The MCP session stays open for the full duration of the `async with` block
        so tool calls don't get "Invalid or expired session" errors.
        Falls back to an empty tool list if the connection fails.
        """
        self._validate_endpoint(mcp_endpoint, site_url)
        auth = base64.b64encode(f"{username}:{app_password}".encode()).decode()
        logger.info(
            "[WpConnectionService] connecting to MCP endpoint: %s (user: %s)",
            mcp_endpoint,
            username,
        )
        return _McpToolsContext(mcp_endpoint, auth)


class _McpToolsContext:
    """
    Explicit async context manager for the MCP connection.

    Using a class (not @asynccontextmanager) avoids the
    'generator didn't stop after athrow()' error that occurs when an exception
    propagates out of a nested async-with inside an asynccontextmanager generator.
    """

    def __init__(self, mcp_endpoint: str, auth_header: str) -> None:
        self._mcp_endpoint = mcp_endpoint
        self._auth_header = auth_header
        self._client: MultiServerMCPClient | None = None
        self._tools: list = []

    async def __aenter__(self) -> list:
        # Deferred: langchain_mcp_adapters is an optional dependency not needed at import time.
        from langchain_mcp_adapters.client import MultiServerMCPClient  # pylint: disable=import-outside-toplevel

        try:
            self._client = MultiServerMCPClient(
                {
                    "wp": {
                        "url": self._mcp_endpoint,
                        "transport": "streamable_http",
                        "headers": {"Authorization": f"Basic {self._auth_header}"},
                    }
                }
            )
            # langchain-mcp-adapters 0.1.0+ dropped context manager support — call get_tools() directly
            self._tools = await self._client.get_tools()
            logger.info(
                "[WpConnectionService] MCP tools loaded (%d): %s",
                len(self._tools),
                ", ".join(t.name for t in self._tools) or "(none)",
            )
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning("[WpConnectionService] MCP connection failed — running without tools: %s", exc)
            self._client = None
            self._tools = []
        return self._tools

    async def __aexit__(self, exc_type: object, exc_val: object, exc_tb: object) -> bool:
        return False
