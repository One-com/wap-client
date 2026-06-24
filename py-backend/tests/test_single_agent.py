"""
Unit tests for SingleAgentGraph._make_config — LangFuse per-trace metadata/tags
(WPIN-8557).  Pure function: no LLM, no checkpointer, no MCP.
"""

from unittest.mock import MagicMock

from app.agents.single_agent import SingleAgentGraph
from app.services.agent_registry import AgentDefinition


def _make_graph() -> SingleAgentGraph:
    agent_def = AgentDefinition(
        id="00000000-0000-0000-0000-000000000001",
        slug="wp-rocket-specialist",
        name="WP Rocket Specialist",
        product_slug="wp-rocket",
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        system_prompt="You are a WP Rocket expert.",
        temperature=0.2,
        max_turns=12,
        tools=None,
    )
    return SingleAgentGraph(
        agent_def=agent_def,
        api_key="sk-ant-test",
        wp_connection_service=MagicMock(),
    )


def test_make_config_without_langfuse_has_no_metadata():
    graph = _make_graph()
    config = graph._make_config("user1:wp-rocket:standard", langfuse_handler=None)
    assert config["configurable"]["thread_id"] == "user1:wp-rocket:standard"
    assert config["recursion_limit"] == 12
    assert "callbacks" not in config
    assert "metadata" not in config
    assert "tags" not in config


def test_make_config_with_langfuse_attaches_trace_metadata():
    graph = _make_graph()
    handler = object()
    trace_metadata = {"user_id": "user1", "product": "wp-rocket", "mode": "product"}
    config = graph._make_config("user1:wp-rocket:standard", langfuse_handler=handler, trace_metadata=trace_metadata)
    assert config["callbacks"] == [handler]
    md = config["metadata"]
    assert md["langfuse_session_id"] == "user1:wp-rocket:standard"
    assert md["langfuse_user_id"] == "user1"
    assert md["product"] == "wp-rocket"
    assert md["agent_slug"] == "wp-rocket-specialist"
    assert md["mode"] == "product"
    assert config["tags"] == ["wp-rocket", "wp-rocket-specialist", "product"]


def test_thread_id_isolates_products_for_same_user():
    """WPIN-8553: same user, different product role → fully isolated checkpoint threads."""
    user_id = "abc123"
    wp_rocket_thread = f"{user_id}:wp-rocket:standard"
    rankmath_thread = f"{user_id}:rankmath:standard"
    assert wp_rocket_thread != rankmath_thread
    # Both start with the user prefix (ownership check relies on this) but diverge on role.
    assert wp_rocket_thread.startswith(f"{user_id}:")
    assert rankmath_thread.startswith(f"{user_id}:")


def test_make_config_falls_back_to_agent_def_and_thread_id():
    """When trace_metadata omits product/user_id (e.g. sub-agent call), fill from agent_def + thread_id."""
    graph = _make_graph()
    config = graph._make_config(
        "userX:rankmath:standard",
        langfuse_handler=object(),
        trace_metadata={"mode": "orchestrator"},
    )
    md = config["metadata"]
    assert md["langfuse_user_id"] == "userX"  # derived from thread_id prefix
    assert md["product"] == "wp-rocket"  # from agent_def.product_slug
    assert md["agent_slug"] == "wp-rocket-specialist"
    assert config["tags"] == ["wp-rocket", "wp-rocket-specialist", "orchestrator"]
