"""
Unit tests for app/lib/tools.py — tool resolution logic.
"""

from unittest.mock import MagicMock

from langchain_core.tools import BaseTool

from app.lib.request_context import RequestContext
from app.lib.tools import (
    ANTHROPIC_SERVER_TOOLS,
    BUILTIN_TOOLS,
    InvokeSpecialistTool,
    build_contextual_tools,
    resolve_tools,
)


def _make_mcp_tool(name: str) -> BaseTool:
    tool = MagicMock(spec=BaseTool)
    tool.name = name
    return tool


# ── resolve_tools ─────────────────────────────────────────────────────────────


def test_resolve_tools_none_returns_empty():
    assert resolve_tools(None, []) == []


def test_resolve_tools_empty_list_returns_empty():
    assert resolve_tools([], []) == []


def test_resolve_tools_mcp_no_allow_passes_all():
    mcp_tools = [_make_mcp_tool("read_option"), _make_mcp_tool("update_option")]
    result = resolve_tools([{"type": "mcp"}], mcp_tools)
    assert result == mcp_tools


def test_resolve_tools_mcp_with_allow_filters():
    mcp_tools = [_make_mcp_tool("read_option"), _make_mcp_tool("update_option"), _make_mcp_tool("clear_cache")]
    result = resolve_tools([{"type": "mcp", "allow": ["read_option", "clear_cache"]}], mcp_tools)
    assert len(result) == 2
    names = {t.name for t in result}
    assert names == {"read_option", "clear_cache"}


def test_resolve_tools_mcp_allow_excludes_unknown():
    mcp_tools = [_make_mcp_tool("tool_a")]
    # allow-list references a tool not in mcp_tools — it's excluded silently
    result = resolve_tools([{"type": "mcp", "allow": ["tool_a", "nonexistent"]}], mcp_tools)
    assert len(result) == 1
    assert result[0].name == "tool_a"


def test_resolve_tools_allow_list_is_hard_boundary():
    """WPIN-8552: a tool the MCP server exposes but NOT in `allow` must be unreachable."""
    mcp_tools = [
        _make_mcp_tool("read_option"),
        _make_mcp_tool("update_option"),  # dangerous write — server exposes it
        _make_mcp_tool("delete_everything"),  # dangerous — server exposes it
    ]
    result = resolve_tools([{"type": "mcp", "allow": ["read_option"]}], mcp_tools)
    names = {t.name for t in result}
    assert names == {"read_option"}
    # The disallowed tools are absent from the resolved set even though the server offers them.
    assert "update_option" not in names
    assert "delete_everything" not in names


def test_resolve_tools_empty_allow_list_exposes_nothing():
    """An explicit empty allow-list resolves to no MCP tools (deny-all)."""
    mcp_tools = [_make_mcp_tool("read_option"), _make_mcp_tool("update_option")]
    result = resolve_tools([{"type": "mcp", "allow": []}], mcp_tools)
    assert result == []


def test_resolve_tools_builtin_web_fetch():
    result = resolve_tools([{"type": "builtin", "name": "web_fetch"}], [])
    assert len(result) == 1
    assert isinstance(result[0], dict)
    assert result[0]["type"] == "web_fetch_20260209"
    assert result[0]["name"] == "web_fetch"


def test_resolve_tools_builtin_unknown_skipped(caplog):
    import logging

    with caplog.at_level(logging.ERROR, logger="app.lib.tools"):
        result = resolve_tools([{"type": "builtin", "name": "nonexistent_tool"}], [])
    assert result == []
    assert "unknown builtin tool" in caplog.text


def test_resolve_tools_unknown_type_skipped(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="app.lib.tools"):
        result = resolve_tools([{"type": "agent", "role": "x:y"}], [])
    assert result == []


def test_resolve_tools_combined():
    mcp_tools = [_make_mcp_tool("read_option")]
    result = resolve_tools(
        [{"type": "mcp"}, {"type": "builtin", "name": "web_fetch"}],
        mcp_tools,
    )
    assert len(result) == 2
    # MCP tool is a BaseTool instance
    assert any(isinstance(t, BaseTool) and t.name == "read_option" for t in result)
    # web_fetch is now a server-side dict
    assert any(isinstance(t, dict) and t["name"] == "web_fetch" for t in result)


# ── web_search (Anthropic server-side tool) ───────────────────────────────────


def test_web_search_in_server_tool_registry():
    assert "web_search" in ANTHROPIC_SERVER_TOOLS
    tool = ANTHROPIC_SERVER_TOOLS["web_search"]
    assert tool["type"] == "web_search_20260209"
    assert tool["name"] == "web_search"


def test_web_search_not_in_builtin_tools():
    # web_search is server-side — it must not appear in the local BaseTool registry
    assert "web_search" not in BUILTIN_TOOLS


def test_resolve_tools_web_search_returns_dict():
    result = resolve_tools([{"type": "builtin", "name": "web_search"}], [])
    assert len(result) == 1
    assert isinstance(result[0], dict)
    assert result[0]["type"] == "web_search_20260209"
    assert result[0]["name"] == "web_search"


def test_resolve_tools_web_search_dict_is_registry_object():
    # resolve_tools must return the exact dict from ANTHROPIC_SERVER_TOOLS
    result = resolve_tools([{"type": "builtin", "name": "web_search"}], [])
    assert result[0] is ANTHROPIC_SERVER_TOOLS["web_search"]


def test_resolve_tools_web_search_with_mcp_and_web_fetch():
    mcp_tools = [_make_mcp_tool("read_option")]
    result = resolve_tools(
        [
            {"type": "mcp"},
            {"type": "builtin", "name": "web_fetch"},
            {"type": "builtin", "name": "web_search"},
        ],
        mcp_tools,
    )
    assert len(result) == 3
    # MCP tool is a BaseTool instance; web_fetch and web_search are server-side dicts
    base_tools = [t for t in result if isinstance(t, BaseTool)]
    server_dicts = [t for t in result if isinstance(t, dict)]
    assert len(base_tools) == 1 and base_tools[0].name == "read_option"
    assert len(server_dicts) == 2
    dict_names = {d["name"] for d in server_dicts}
    assert dict_names == {"web_fetch", "web_search"}


def test_resolve_tools_web_search_ordering():
    # Order must match the descriptor order
    result = resolve_tools(
        [
            {"type": "builtin", "name": "web_search"},
            {"type": "builtin", "name": "web_fetch"},
        ],
        [],
    )
    assert len(result) == 2
    assert isinstance(result[0], dict) and result[0]["name"] == "web_search"
    assert isinstance(result[1], dict) and result[1]["name"] == "web_fetch"


# ── web_fetch (Anthropic server-side tool) ────────────────────────────────────


def test_web_fetch_in_server_tool_registry():
    assert "web_fetch" in ANTHROPIC_SERVER_TOOLS
    tool = ANTHROPIC_SERVER_TOOLS["web_fetch"]
    assert tool["type"] == "web_fetch_20260209"
    assert tool["name"] == "web_fetch"


def test_web_fetch_not_in_builtin_tools():
    assert "web_fetch" not in BUILTIN_TOOLS


def test_resolve_tools_web_fetch_returns_dict():
    result = resolve_tools([{"type": "builtin", "name": "web_fetch"}], [])
    assert len(result) == 1
    assert isinstance(result[0], dict)
    assert result[0]["type"] == "web_fetch_20260209"
    assert result[0]["name"] == "web_fetch"


def test_resolve_tools_web_fetch_dict_is_registry_object():
    result = resolve_tools([{"type": "builtin", "name": "web_fetch"}], [])
    assert result[0] is ANTHROPIC_SERVER_TOOLS["web_fetch"]


# ── build_contextual_tools ────────────────────────────────────────────────────


def _ctx_kwargs(**overrides):
    defaults = dict(
        registry=MagicMock(),
        api_key="sk-test",
        wp_connection_service=MagicMock(),
        available_products=["wp-rocket"],
        context=RequestContext(
            user_id="user123",
            mcp_endpoint="https://example.com/mcp",
            site_url="https://example.com",
            cred_username="admin",
            cred_app_password="pass",
            langfuse_handler=None,
        ),
    )
    defaults.update(overrides)
    return defaults


def test_build_contextual_tools_none_defs_returns_empty():
    assert build_contextual_tools(None, **_ctx_kwargs()) == {}


def test_build_contextual_tools_no_contextual_defs_returns_empty():
    tool_defs = [{"type": "mcp"}, {"type": "builtin", "name": "web_fetch"}]
    result = build_contextual_tools(tool_defs, **_ctx_kwargs())
    assert result == {}


def test_build_contextual_tools_invoke_specialist_declared():
    tool_defs = [{"type": "builtin", "name": "invoke_specialist"}]
    result = build_contextual_tools(tool_defs, **_ctx_kwargs())
    assert "invoke_specialist" in result
    assert isinstance(result["invoke_specialist"], InvokeSpecialistTool)


def test_build_contextual_tools_mixed_defs_only_contextual_returned():
    tool_defs = [
        {"type": "mcp"},
        {"type": "builtin", "name": "web_fetch"},
        {"type": "builtin", "name": "invoke_specialist"},
    ]
    result = build_contextual_tools(tool_defs, **_ctx_kwargs())
    assert set(result.keys()) == {"invoke_specialist"}


def test_build_contextual_tools_passes_kwargs_to_invoke_specialist():
    tool_defs = [{"type": "builtin", "name": "invoke_specialist"}]
    products = ["wp-rocket", "rankmath"]
    result = build_contextual_tools(tool_defs, **_ctx_kwargs(available_products=products))
    assert result["invoke_specialist"].available_products == products
