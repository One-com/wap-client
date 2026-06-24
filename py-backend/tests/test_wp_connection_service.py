"""
Unit tests for WpConnectionService — SSRF guard and MCP connection lifecycle.

_is_private() is a module-level function and tested directly.
WpConnectionService._validate_endpoint() is tested for the bypass and
production (hostname mismatch, private IP) branches.
_McpToolsContext.__aenter__ is tested for the connection-failure fallback.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import Settings
from app.services.wp_connection_service import WpConnectionService, _is_private

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_settings(bypass: bool = True) -> Settings:
    return Settings(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        SESSION_ENCRYPTION_KEY="dGVzdGtleXJlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=bypass,
    )


# ── _is_private ───────────────────────────────────────────────────────────────


def test_is_private_loopback_ipv4():
    assert _is_private("127.0.0.1") is True


def test_is_private_loopback_ipv6():
    assert _is_private("::1") is True


def test_is_private_rfc1918_10_network():
    assert _is_private("10.0.0.1") is True


def test_is_private_rfc1918_192_168():
    assert _is_private("192.168.1.1") is True


def test_is_private_rfc1918_172_16():
    assert _is_private("172.16.0.1") is True


def test_is_private_link_local():
    assert _is_private("169.254.1.1") is True


def test_is_private_public_ip():
    assert _is_private("8.8.8.8") is False


def test_is_private_unresolvable_hostname_treated_as_private():
    # Fail-closed: unresolvable hostnames are treated as private
    assert _is_private("this-hostname-does-not-exist.invalid.zz") is True


# ── _validate_endpoint ────────────────────────────────────────────────────────


def test_validate_endpoint_bypass_does_not_raise():
    svc = WpConnectionService(_make_settings(bypass=True))
    # Should not raise even for localhost
    svc._validate_endpoint("http://localhost/mcp", "http://localhost")


def test_validate_endpoint_hostname_mismatch_raises():
    svc = WpConnectionService(_make_settings(bypass=False))
    with pytest.raises(ValueError, match="does not match"):
        svc._validate_endpoint("https://evil.com/mcp", "https://example.com")


def test_validate_endpoint_private_ip_raises():
    svc = WpConnectionService(_make_settings(bypass=False))
    with patch("app.services.wp_connection_service._is_private", return_value=True):
        with pytest.raises(ValueError, match="private"):
            svc._validate_endpoint("https://example.com/mcp", "https://example.com")


# ── _McpToolsContext ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mcp_tools_context_success():
    svc = WpConnectionService(_make_settings(bypass=True))
    mock_tool = MagicMock()
    mock_tool.name = "get_option"

    mock_client = MagicMock()
    mock_client.get_tools = AsyncMock(return_value=[mock_tool])

    with patch("langchain_mcp_adapters.client.MultiServerMCPClient", return_value=mock_client):
        ctx = svc.mcp_tools_context(
            "http://example.com/mcp",
            "http://example.com",
            "admin",
            "pass word",
        )
        async with ctx as tools:
            assert len(tools) == 1
            assert tools[0].name == "get_option"


@pytest.mark.asyncio
async def test_mcp_tools_context_connection_failure_returns_empty_list():
    svc = WpConnectionService(_make_settings(bypass=True))

    with patch(
        "langchain_mcp_adapters.client.MultiServerMCPClient",
        side_effect=Exception("connection refused"),
    ):
        ctx = svc.mcp_tools_context(
            "http://example.com/mcp",
            "http://example.com",
            "admin",
            "pass word",
        )
        async with ctx as tools:
            assert tools == []
