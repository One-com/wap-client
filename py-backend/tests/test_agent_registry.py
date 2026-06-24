"""
Unit tests for AgentRegistry.

Tests snippet resolution, get_by_role, failure modes, and pub/sub behaviour.
All DB interaction is mocked — no Postgres needed.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.agent_registry import AgentDefinition, AgentRegistry, _resolve_snippets

# ── Snippet resolution ─────────────────────────────────────────────────────────


def test_resolve_snippets_no_placeholders():
    prompt = "Hello, world!"
    assert _resolve_snippets(prompt, {}, "test-agent") == "Hello, world!"


def test_resolve_snippets_single():
    prompt = "Prefix\n{{snippet:mcp_usage}}\nSuffix"
    snippets = {"mcp_usage": "MCP instructions here"}
    result = _resolve_snippets(prompt, snippets, "test-agent")
    assert result == "Prefix\nMCP instructions here\nSuffix"


def test_resolve_snippets_multiple():
    prompt = "{{snippet:a}} and {{snippet:b}}"
    snippets = {"a": "AAA", "b": "BBB"}
    result = _resolve_snippets(prompt, snippets, "test-agent")
    assert result == "AAA and BBB"


def test_resolve_snippets_missing_key_raises():
    prompt = "{{snippet:missing}}"
    with pytest.raises(ValueError, match="missing snippet"):
        _resolve_snippets(prompt, {}, "bad-agent")


def test_resolve_snippets_extra_snippets_ignored():
    prompt = "{{snippet:used}}"
    snippets = {"used": "yes", "unused": "no"}
    result = _resolve_snippets(prompt, snippets, "test-agent")
    assert result == "yes"


# ── AgentRegistry.get_by_role ─────────────────────────────────────────────────


def _make_registry_with_agents(agents_list):
    """Helper: build a registry with pre-populated cache (no Redis, no pub/sub)."""
    registry = AgentRegistry.__new__(AgentRegistry)
    registry._cache = {a.id: a for a in agents_list}
    registry._role_map = {}
    registry._redis = None
    registry._subscriber_task = None
    registry._last_pubsub_heartbeat = 0.0
    registry._pubsub_staleness_threshold_s = 30
    return registry


def _make_agent(agent_id="abc", slug="test", product="wp-rocket", role=None):
    return AgentDefinition(
        id=agent_id,
        slug=slug,
        name="Test Agent",
        product_slug=product,
        provider="anthropic",
        model="claude-sonnet-4-5-20250929",
        system_prompt="You are a test agent.",
        temperature=0.3,
        max_turns=25,
        tools=None,
    )


def test_get_by_role_returns_agent():
    agent = _make_agent()
    registry = _make_registry_with_agents([agent])
    registry._role_map = {"wp-rocket:standard": "abc"}
    result = registry.get_by_role("wp-rocket:standard")
    assert result is agent


def test_get_by_role_unknown_role():
    registry = _make_registry_with_agents([])
    assert registry.get_by_role("nonexistent:role") is None


def test_get_by_product_delegates_to_get_by_role():
    agent = _make_agent()
    registry = _make_registry_with_agents([agent])
    registry._role_map = {"wp-rocket:standard": "abc"}
    result = registry.get_by_product("wp-rocket")
    assert result is agent


def test_all_returns_all_cached():
    agents = [_make_agent("a1"), _make_agent("a2")]
    registry = _make_registry_with_agents(agents)
    assert len(registry.all()) == 2


def test_all_roles_returns_role_list():
    agent = _make_agent()
    registry = _make_registry_with_agents([agent])
    registry._role_map = {"wp-rocket:standard": "abc"}
    roles = registry.all_roles()
    assert len(roles) == 1
    assert roles[0]["role"] == "wp-rocket:standard"
    assert roles[0]["agentId"] == "abc"


def test_invalidate_removes_from_cache():
    agent = _make_agent()
    registry = _make_registry_with_agents([agent])
    assert registry.get_by_id("abc") is agent
    registry.invalidate("abc")
    assert registry.get_by_id("abc") is None


# ── AgentDefinition.to_dict ───────────────────────────────────────────────────


def test_agent_definition_to_dict():
    agent = _make_agent()
    d = agent.to_dict()
    assert d["id"] == "abc"
    assert d["slug"] == "test"
    assert d["maxTurns"] == 25
    assert d["tools"] is None
    assert "systemPrompt" in d


# ── Pub/sub: pubsub_healthy ───────────────────────────────────────────────────


def test_pubsub_healthy_no_redis():
    registry = _make_registry_with_agents([])
    assert registry.pubsub_healthy is True


def test_pubsub_healthy_task_running_no_heartbeat_yet():

    registry = _make_registry_with_agents([])
    registry._redis = MagicMock()
    task = MagicMock(spec=asyncio.Task)
    task.done.return_value = False
    registry._subscriber_task = task
    registry._last_pubsub_heartbeat = 0.0
    assert registry.pubsub_healthy is True


def test_pubsub_healthy_task_running_fresh_heartbeat():

    registry = _make_registry_with_agents([])
    registry._redis = MagicMock()
    task = MagicMock(spec=asyncio.Task)
    task.done.return_value = False
    registry._subscriber_task = task
    registry.record_pubsub_heartbeat()
    assert registry.pubsub_healthy is True


def test_pubsub_healthy_stale_heartbeat():
    import time

    registry = _make_registry_with_agents([])
    registry._redis = MagicMock()
    registry._pubsub_staleness_threshold_s = 1
    task = MagicMock(spec=asyncio.Task)
    task.done.return_value = False
    registry._subscriber_task = task
    # Simulate a heartbeat 10 seconds ago
    registry._last_pubsub_heartbeat = time.monotonic() - 10
    assert registry.pubsub_healthy is False


def test_pubsub_healthy_task_done():
    registry = _make_registry_with_agents([])
    registry._redis = MagicMock()
    task = MagicMock(spec=asyncio.Task)
    task.done.return_value = True
    registry._subscriber_task = task
    assert registry.pubsub_healthy is False


def test_pubsub_healthy_no_task():
    registry = _make_registry_with_agents([])
    registry._redis = MagicMock()
    registry._subscriber_task = None
    assert registry.pubsub_healthy is False


# ── Pub/sub: _publish ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_publish_skipped_when_no_redis():
    registry = _make_registry_with_agents([])
    # Should not raise — just a no-op
    await registry._publish({"action": "reload_agent", "agent_id": "abc"})


@pytest.mark.asyncio
async def test_publish_calls_redis_publish():
    registry = _make_registry_with_agents([])
    mock_redis = AsyncMock()
    registry._redis = mock_redis

    await registry._publish({"action": "reload_all"})

    mock_redis.publish.assert_awaited_once()
    channel, payload = mock_redis.publish.call_args[0]
    assert channel == "agent_cache_invalidation"
    assert json.loads(payload) == {"action": "reload_all"}


@pytest.mark.asyncio
async def test_publish_swallows_redis_errors(caplog):
    registry = _make_registry_with_agents([])
    mock_redis = AsyncMock()
    mock_redis.publish.side_effect = ConnectionError("redis gone")
    registry._redis = mock_redis

    # Should not raise
    await registry._publish({"action": "reload_all"})


# ── Pub/sub: handle_invalidation_message ─────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_invalid_json_is_ignored(caplog):
    registry = _make_registry_with_agents([])
    await registry.handle_invalidation_message("not json {{")


@pytest.mark.asyncio
async def test_handle_unknown_action_is_ignored(caplog):
    registry = _make_registry_with_agents([])
    await registry.handle_invalidation_message(json.dumps({"action": "unknown_future_action"}))


@pytest.mark.asyncio
async def test_handle_reload_agent_updates_cache():
    import uuid as _uuid

    agent_id = str(_uuid.uuid4())
    registry = _make_registry_with_agents([])
    registry._session_factory = MagicMock()

    updated_agent = _make_agent(agent_id=agent_id, slug="updated")

    # Patch the DB calls inside handle_invalidation_message
    with (
        patch.object(registry, "_session_factory") as mock_sf,
        patch("app.services.agent_registry._row_to_def", return_value=updated_agent),
    ):
        mock_session = AsyncMock()
        mock_sf.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_sf.return_value.__aexit__ = AsyncMock(return_value=False)

        mock_row = MagicMock()
        mock_row.id = _uuid.UUID(agent_id)
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_row
        mock_session.execute = AsyncMock(return_value=mock_result)

        await registry.handle_invalidation_message(json.dumps({"action": "reload_agent", "agent_id": agent_id}))

    assert registry._cache.get(agent_id) is updated_agent
