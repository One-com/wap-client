"""
Route-level integration tests for GET /api/v1/chat/{thread_id}/history
and POST /api/v1/chat/stream.

Streaming is tested at the SSE-parsing level — the agent graph is mocked to
yield pre-canned SSE strings so we verify routing, auth, rate-limiting, and
the history endpoint without hitting Anthropic or Postgres.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage, HumanMessage

from app.config import Settings
from app.dependencies import (
    get_agent_registry,
    get_checkpointer,
    get_rate_limiter,
    get_session_factory,
    get_session_service,
    get_settings,
    get_summarizer,
    get_wp_connection_service,
)
from app.main import create_app
from app.services.session_service import SessionData
from tests.conftest import make_app_state

# ── Helpers ───────────────────────────────────────────────────────────────────


@asynccontextmanager
async def _noop_lifespan(app):
    yield


def _make_settings() -> Settings:
    return Settings(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        # base64("testkeytestkeytestkeytestkey1234") — exactly 32 bytes for AES-256
        SESSION_ENCRYPTION_KEY="dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=True,
        ENV="test",
    )


def _make_session(mode: str = "product") -> SessionData:
    return SessionData(
        user_id="abc123def456abc123def456abc12345",
        product="wp-rocket",
        site_url="https://example.com",
        mcp_endpoint="https://example.com/wp-json/mcp/server",
        mode=mode,
        available_products=["wp-rocket"],
        created_at=1700000000000,
    )


def _make_rate_limiter(allowed: bool = True):
    mock_rl = MagicMock()
    result = MagicMock()
    result.allowed = allowed
    result.reset_at = 9999999999
    mock_rl.check = AsyncMock(return_value=result)
    return mock_rl


def _make_agent_registry():
    agent = MagicMock()
    agent.id = "agent-1"
    agent.name = "WP Rocket Agent"
    agent.model = "claude-sonnet-4-6"
    agent.tools = []
    agent.temperature = 0.5
    agent.system_prompt = "You are a helpful assistant."
    agent.max_turns = 10
    mock_registry = MagicMock()
    mock_registry.get_by_role = MagicMock(return_value=agent)
    return mock_registry


def _make_checkpointer(messages=None):
    mock_cp = AsyncMock()
    if messages is None:
        mock_cp.aget_tuple = AsyncMock(return_value=None)
    else:
        ct = MagicMock()
        ct.checkpoint = {"channel_values": {"messages": messages}}
        mock_cp.aget_tuple = AsyncMock(return_value=ct)
    return mock_cp


def _make_db_session_factory():
    mock_db = AsyncMock()
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None)))
    return MagicMock(return_value=mock_db)


@pytest_asyncio.fixture
async def app():
    _app = create_app(app_lifespan=_noop_lifespan)

    mock_session_svc = AsyncMock()
    mock_session_svc.validate = AsyncMock(return_value=_make_session())

    _app.dependency_overrides[get_settings] = lambda: _make_settings()
    _app.dependency_overrides[get_session_service] = lambda: mock_session_svc
    _app.dependency_overrides[get_agent_registry] = lambda: _make_agent_registry()
    _app.dependency_overrides[get_rate_limiter] = lambda: _make_rate_limiter()
    _app.dependency_overrides[get_checkpointer] = lambda: _make_checkpointer()
    _app.dependency_overrides[get_session_factory] = lambda: _make_db_session_factory()
    _app.dependency_overrides[get_wp_connection_service] = lambda: MagicMock()
    _app.dependency_overrides[get_summarizer] = lambda: None

    # get_langfuse_handler reads typed app state directly (not overridden above).
    _app.state.typed = make_app_state(langfuse_handler=None)

    return _app


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


AUTH = {"Authorization": "Bearer valid-token"}


# ── GET /api/v1/chat/{thread_id}/history ─────────────────────────────────────


@pytest.mark.asyncio
async def test_history_no_checkpoint(client):
    uid = "abc123def456abc123def456abc12345"
    resp = await client.get(f"/api/v1/chat/{uid}:wp-rocket:standard/history", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["messages"] == []


@pytest.mark.asyncio
async def test_history_empty_thread_returns_200_empty_list(app, client):
    """WPIN-8558: a thread that exists but holds zero messages returns 200 + [] (not 404)."""
    app.dependency_overrides[get_checkpointer] = lambda: _make_checkpointer([])

    uid = "abc123def456abc123def456abc12345"
    resp = await client.get(f"/api/v1/chat/{uid}:wp-rocket:standard/history", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["messages"] == []


@pytest.mark.asyncio
async def test_history_with_messages(app, client):
    msgs = [HumanMessage(content="Hello"), AIMessage(content="Hi there")]
    app.dependency_overrides[get_checkpointer] = lambda: _make_checkpointer(msgs)

    uid = "abc123def456abc123def456abc12345"
    resp = await client.get(f"/api/v1/chat/{uid}:wp-rocket:standard/history", headers=AUTH)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 2
    assert data["messages"][0] == {"role": "user", "content": "Hello"}
    assert data["messages"][1] == {"role": "assistant", "content": "Hi there"}


@pytest.mark.asyncio
async def test_history_limit_respected(app, client):
    msgs = [HumanMessage(content=f"msg{i}") for i in range(50)]
    app.dependency_overrides[get_checkpointer] = lambda: _make_checkpointer(msgs)

    uid = "abc123def456abc123def456abc12345"
    resp = await client.get(
        f"/api/v1/chat/{uid}:wp-rocket:standard/history",
        params={"limit": 5},
        headers=AUTH,
    )
    assert resp.status_code == 200
    assert len(resp.json()["messages"]) == 5


@pytest.mark.asyncio
async def test_history_forbidden_for_wrong_user(client):
    # Two-part format is not translated — ownership check fires directly
    resp = await client.get(
        "/api/v1/chat/other-user-id:wp-rocket/history",
        headers=AUTH,
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


@pytest.mark.asyncio
async def test_history_requires_auth(client):
    uid = "abc123def456abc123def456abc12345"
    resp = await client.get(f"/api/v1/chat/{uid}:wp-rocket:standard/history")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_history_translates_php_conversation_id(app, client):
    """PHP sends {wp_user_id}:{product}:standard; route translates to internal format."""
    msgs = [AIMessage(content="translated")]
    app.dependency_overrides[get_checkpointer] = lambda: _make_checkpointer(msgs)

    # "42:wp-rocket:standard" gets translated to "{uid}:wp-rocket" which passes
    # the ownership check since it starts with the session's user_id.
    resp = await client.get("/api/v1/chat/42:wp-rocket:standard/history", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["messages"][0]["content"] == "translated"


# ── POST /api/v1/chat/stream ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_requires_auth(client):
    resp = await client.post("/api/v1/chat/stream", json={"message": "hello"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_stream_rate_limited(app, client):
    app.dependency_overrides[get_rate_limiter] = lambda: _make_rate_limiter(allowed=False)
    resp = await client.post("/api/v1/chat/stream", json={"message": "hi"}, headers=AUTH)
    assert resp.status_code == 429
    assert resp.json()["detail"]["error"] == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_stream_empty_message_rejected(client):
    resp = await client.post("/api/v1/chat/stream", json={"message": ""}, headers=AUTH)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_stream_no_agent_returns_error_event(app, client):
    mock_registry = MagicMock()
    mock_registry.get_by_role = MagicMock(return_value=None)
    app.dependency_overrides[get_agent_registry] = lambda: mock_registry

    resp = await client.post("/api/v1/chat/stream", json={"message": "hello"}, headers=AUTH)
    assert resp.status_code == 200  # StreamingResponse always returns 200
    assert "No active agent" in resp.text


@pytest.mark.asyncio
async def test_stream_yields_sse_events(client):
    """Full SSE envelope is yielded — agent graph mocked to return canned events."""
    from app.lib.sse import format_sse, format_sse_done

    canned = [
        format_sse({"type": "message_start", "conversationId": "abc123:wp-rocket:standard", "mode": "product"}),
        format_sse({"type": "text_delta", "delta": "Hello!"}),
        format_sse({"type": "message_end", "usage": {"inputTokens": 10, "outputTokens": 5}}),
        format_sse_done(),
    ]

    async def mock_stream(**kwargs):
        for chunk in canned:
            yield chunk

    mock_graph_instance = MagicMock()
    mock_graph_instance.stream = mock_stream

    with patch("app.agents.single_agent.SingleAgentGraph", return_value=mock_graph_instance):
        resp = await client.post("/api/v1/chat/stream", json={"message": "hello"}, headers=AUTH)

    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    body = resp.text
    assert "message_start" in body
    assert "Hello!" in body
    assert "[DONE]" in body


@pytest.mark.asyncio
async def test_stream_product_mode_no_invoke_specialist(app):
    """Product-mode agents without invoke_specialist descriptor get no InvokeSpecialistTool."""
    from app.lib.sse import format_sse_done

    agent = MagicMock()
    agent.id = "agent-1"
    agent.tools = [{"type": "mcp"}]  # no invoke_specialist
    agent.model = "claude-sonnet-4-6"
    agent.temperature = 0.3
    agent.system_prompt = "You are a helper."
    agent.max_turns = 10

    registry = MagicMock()
    registry.get_by_role = MagicMock(return_value=agent)
    registry.role_for_session = MagicMock(return_value="wp-rocket:standard")
    app.dependency_overrides[get_agent_registry] = lambda: registry

    captured_extra_tools = []

    async def mock_stream(**kwargs):
        yield format_sse_done()

    def capture_graph(*args, **kwargs):
        captured_extra_tools.extend(kwargs.get("extra_tools", []))
        m = MagicMock()
        m.stream = mock_stream
        return m

    with patch("app.agents.single_agent.SingleAgentGraph", side_effect=capture_graph):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            await ac.post("/api/v1/chat/stream", json={"message": "hi"}, headers=AUTH)

    from app.lib.tools import InvokeSpecialistTool

    assert not any(isinstance(t, InvokeSpecialistTool) for t in captured_extra_tools)


@pytest.mark.asyncio
async def test_stream_orchestrator_mode_gets_invoke_specialist(app):
    """Orchestrator agent with invoke_specialist descriptor receives InvokeSpecialistTool."""
    from app.lib.sse import format_sse_done

    agent = MagicMock()
    agent.id = "agent-2"
    agent.tools = [{"type": "builtin", "name": "invoke_specialist"}]
    agent.model = "claude-sonnet-4-6"
    agent.temperature = 0.2
    agent.system_prompt = "You are an orchestrator."
    agent.max_turns = 15

    session = _make_session(mode="orchestrator")
    mock_session_svc = AsyncMock()
    mock_session_svc.validate = AsyncMock(return_value=session)

    registry = MagicMock()
    registry.get_by_role = MagicMock(return_value=agent)
    registry.role_for_session = MagicMock(return_value="global:orchestrator")
    app.dependency_overrides[get_agent_registry] = lambda: registry
    app.dependency_overrides[get_session_service] = lambda: mock_session_svc

    captured_extra_tools = []

    async def mock_stream(**kwargs):
        yield format_sse_done()

    def capture_graph(*args, **kwargs):
        captured_extra_tools.extend(kwargs.get("extra_tools", []))
        m = MagicMock()
        m.stream = mock_stream
        return m

    with patch("app.agents.single_agent.SingleAgentGraph", side_effect=capture_graph):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            await ac.post("/api/v1/chat/stream", json={"message": "hi"}, headers=AUTH)

    from app.lib.tools import InvokeSpecialistTool

    assert any(isinstance(t, InvokeSpecialistTool) for t in captured_extra_tools)
