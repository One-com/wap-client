# pylint: disable=cyclic-import
"""
Built-in tool registry and tool resolution.

BUILTIN_TOOLS maps name → LangChain BaseTool instance for stateless tools.
ANTHROPIC_SERVER_TOOLS maps name → raw dict for Anthropic-hosted server-side
tools (web_search, web_fetch via Anthropic's infrastructure).  These are passed
directly to ChatAnthropic.bind_tools as dicts — no custom Python class needed.

resolve_tools() translates an agent's tool descriptor array into
a concrete list of tools (BaseTool instances or server-side dicts) for use in
create_react_agent.

Tool descriptor format (agents.tools JSONB):
  {"type": "mcp"}                           — all MCP tools from the WP adapter
  {"type": "mcp", "allow": ["read_opt"]}   — MCP tools filtered to allow-list (hard security boundary)
  {"type": "builtin", "name": "web_fetch"} — Anthropic server-side web fetch
  {"type": "builtin", "name": "web_search"} — Anthropic server-side web search

Contextual tools (need per-request state — registry, credentials, etc.) are
constructed outside and passed via the extra_tools parameter of resolve_tools.
They are identified in the JSONB by name but instantiated by the caller.

  {"type": "builtin", "name": "invoke_specialist"} — routed via extra_tools

Adding a new built-in tool:
  1. Implement the tool class below (or import from a separate module)
  2. Add an instance to BUILTIN_TOOLS (stateless) or document it as contextual
  That's it — no code changes elsewhere needed.

Adding a new Anthropic server-side tool:
  1. Add its dict to ANTHROPIC_SERVER_TOOLS keyed by name
  That's it — langchain_anthropic passes it through to the API unchanged.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field

from app.lib.request_context import RequestContext

logger = logging.getLogger(__name__)


class InvokeSpecialistTool(BaseTool):
    """Call a specialist agent and return its full response as text.

    The orchestrator uses this tool to delegate to product specialists
    (e.g. wp-rocket, rankmath) and receive their answers as tool results,
    which it then synthesises into a final response.

    Constructed per-request with live registry + credentials so the tool
    always reflects the current agent roster and site context.
    """

    name: str = "invoke_specialist"
    description: str = (
        "Invoke a specialist agent for a specific WordPress product and return its response. "
        "Use this to delegate questions about a product to its dedicated expert agent. "
        "Args: specialist_slug (str) — the product slug (e.g. 'wp-rocket', 'rankmath'); "
        "message (str) — the question or task to send to the specialist."
    )

    # Contextual state — injected at construction time, not stored in DB
    registry: Any = Field(exclude=True)
    api_key: str = Field(exclude=True)
    wp_connection_service: Any = Field(exclude=True)
    available_products: list[str] = Field(exclude=True)
    context: RequestContext = Field(exclude=True)

    model_config = {"arbitrary_types_allowed": True}

    def _run(self, specialist_slug: str, message: str, **kwargs: Any) -> str:  # pylint: disable=arguments-differ
        raise NotImplementedError("Use async version")

    # no-member: pydantic Field(exclude=True) attributes (registry, context, …) read as
    # FieldInfo to pylint's static analysis, though they hold their real values at runtime.
    async def _arun(  # pylint: disable=arguments-differ,no-member
        self, specialist_slug: str, message: str, **kwargs: Any
    ) -> str:
        if specialist_slug not in self.available_products:
            available = ", ".join(self.available_products)
            return (
                f"[invoke_specialist error] '{specialist_slug}' is not an available specialist. Available: {available}"
            )

        agent_def = self.registry.get_by_product(specialist_slug)
        if agent_def is None:
            return f"[invoke_specialist error] no agent mapped to role '{specialist_slug}:standard'"

        # Deferred: tools.py ↔ single_agent.py would circular-import at module level.
        from app.agents.single_agent import SingleAgentGraph  # pylint: disable=import-outside-toplevel

        graph = SingleAgentGraph(
            agent_def=agent_def,
            api_key=self.api_key,
            wp_connection_service=self.wp_connection_service,
            # No checkpointer — specialist calls within orchestrator are ephemeral
        )
        thread_id = f"{self.context.user_id}:{specialist_slug}:standard"
        try:
            return await graph.generate(
                message=message,
                thread_id=thread_id,
                context=self.context,
                # Attribute the specialist's sub-trace to the same user; product/agent_slug
                # are filled from the specialist's own agent_def in _make_config.
                trace_metadata={"user_id": self.context.user_id, "mode": "orchestrator"},
            )
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning("[invoke_specialist] %s failed: %s", specialist_slug, exc)
            return f"[invoke_specialist error] {specialist_slug} failed: {exc}"


# Registry of available built-in tools (stateless — instantiated once at import).
BUILTIN_TOOLS: dict[str, BaseTool] = {}

# Anthropic-hosted server-side tools.  Passed as raw dicts to bind_tools —
# execution happens on Anthropic's infrastructure, no SSRF risk to this server.
ANTHROPIC_SERVER_TOOLS: dict[str, dict] = {
    "web_fetch": {"type": "web_fetch_20260209", "name": "web_fetch"},
    "web_search": {"type": "web_search_20260209", "name": "web_search"},
}

# User-facing tool catalog — drives the admin UI checkboxes.
# Each entry has a stable `id`, a human-readable `label` and `description`,
# and the `descriptor` dict written verbatim into the agents.tools JSONB array.
# Order here is the display order in the form.
# Do NOT include invoke_specialist or other internal/contextual tools.
TOOL_CATALOG: list[dict] = [
    {
        "id": "mcp",
        "label": "WordPress MCP",
        "description": "WordPress site tools — discover and execute abilities via the MCP adapter.",
        "descriptor": {"type": "mcp"},
    },
    {
        "id": "web_fetch",
        "label": "Web Fetch",
        "description": "Fetch and read content from URLs (runs on Anthropic's infrastructure).",
        "descriptor": {"type": "builtin", "name": "web_fetch"},
    },
    {
        "id": "web_search",
        "label": "Web Search",
        "description": "Search the web for current information (runs on Anthropic's infrastructure).",
        "descriptor": {"type": "builtin", "name": "web_search"},
    },
]

# Names of built-in tools that are contextual (constructed per-request, not in BUILTIN_TOOLS).
_CONTEXTUAL_TOOL_NAMES = frozenset({"invoke_specialist"})


def build_contextual_tools(
    tool_defs: list[dict] | None,
    *,
    registry: "Any",
    api_key: str,
    wp_connection_service: "Any",
    available_products: list[str],
    context: RequestContext,
) -> dict[str, BaseTool]:
    """Instantiate per-request contextual tools declared in an agent's tool descriptor array.

    Returns a dict keyed by tool name, ready to pass as extra_tools to resolve_tools().
    Only constructs tools that the agent actually declares — agents without invoke_specialist
    in their descriptor get an empty dict.
    """
    if not tool_defs:
        return {}

    declared_contextual = {
        td["name"] for td in tool_defs if td.get("type") == "builtin" and td.get("name") in _CONTEXTUAL_TOOL_NAMES
    }

    result: dict[str, BaseTool] = {}

    if "invoke_specialist" in declared_contextual:
        result["invoke_specialist"] = InvokeSpecialistTool(
            registry=registry,
            api_key=api_key,
            wp_connection_service=wp_connection_service,
            available_products=available_products,
            context=context,
        )

    return result


def resolve_tools(
    tool_defs: list[dict] | None,
    mcp_tools: list[BaseTool],
    extra_tools: dict[str, BaseTool] | None = None,
) -> list[BaseTool | dict]:
    """Build the concrete tool list from an agent's tool descriptor array.

    Args:
        tool_defs: The agents.tools JSONB value (list of descriptors or None).
        mcp_tools: MCP tools already fetched from the WordPress adapter.
        extra_tools: Per-request contextual tools keyed by name (e.g. invoke_specialist).

    Returns:
        Ordered list of tools for create_react_agent — either BaseTool instances
        or raw dicts (for Anthropic server-side tools like web_search).
    """
    if not tool_defs:
        return []

    all_builtins = {**BUILTIN_TOOLS, **(extra_tools or {})}
    result: list[BaseTool | dict] = []

    for td in tool_defs:
        t = td.get("type")

        if t == "mcp":
            allow = td.get("allow")  # None = all MCP tools
            if allow is None:
                result.extend(mcp_tools)
            else:
                # allow-list is a hard security boundary — only named tools pass through
                filtered = [tool for tool in mcp_tools if tool.name in allow]
                if len(filtered) < len(allow):
                    allowed_names = {tool.name for tool in mcp_tools}
                    missing = [n for n in allow if n not in allowed_names]
                    logger.warning(
                        "[resolve_tools] mcp allow-list references tools not found in adapter: %s",
                        missing,
                    )
                result.extend(filtered)

        elif t == "builtin":
            name = td.get("name")
            if not name:
                logger.warning("[resolve_tools] builtin tool descriptor missing 'name'")
                continue
            # Check Anthropic server-side tools first, then local BaseTool registry
            server_tool = ANTHROPIC_SERVER_TOOLS.get(name)
            if server_tool is not None:
                result.append(server_tool)
                continue
            builtin = all_builtins.get(name)
            if builtin is None:
                logger.error(
                    "[resolve_tools] unknown builtin tool '%s' — add it to BUILTIN_TOOLS, "
                    "ANTHROPIC_SERVER_TOOLS, or pass via extra_tools",
                    name,
                )
                continue
            result.append(builtin)

        else:
            logger.warning("[resolve_tools] unknown tool type '%s' — skipped", t)

    return result
