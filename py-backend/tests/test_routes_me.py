"""
Route-level integration tests for DELETE /api/v1/me/data and POST /api/v1/me/data/erase.

me.py reads typed app state directly (not via FastAPI Depends), so we set
app.state.typed (via make_app_state) rather than using dependency_overrides for
session_factory, session_service, and pg_pool.

AsyncPostgresSaver is patched at app.routes.me.AsyncPostgresSaver to avoid
a real database connection.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.dependencies import get_session_service, get_settings
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
        SESSION_ENCRYPTION_KEY="dGVzdGtleXJlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=True,
        ENV="test",
    )


def _make_session_data() -> SessionData:
    return SessionData(
        user_id="abc123def456abc123def456abc12345",
        product="wp-rocket",
        site_url="https://example.com",
        mcp_endpoint="https://example.com/wp-json/mcp/server",
        mode="product",
        available_products=["wp-rocket"],
        created_at=1700000000000,
    )


def _make_db_session_factory():
    mock_db = AsyncMock()
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    begin_cm = AsyncMock()
    begin_cm.__aenter__ = AsyncMock(return_value=begin_cm)
    begin_cm.__aexit__ = AsyncMock(return_value=False)
    mock_db.begin = MagicMock(return_value=begin_cm)
    mock_db.execute = AsyncMock()
    return MagicMock(return_value=mock_db)


async def _empty_aiter():
    return
    yield  # makes this an async generator


async def _one_thread_aiter(user_id: str):
    ct = MagicMock()
    ct.config = {"configurable": {"thread_id": f"{user_id}:wp-rocket:standard"}}
    yield ct


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def app():
    _app = create_app(app_lifespan=_noop_lifespan)

    # me.py reads app.state directly — wire them here
    mock_session_svc = AsyncMock()
    mock_session_svc.validate = AsyncMock(return_value=_make_session_data())
    mock_session_svc.revoke = AsyncMock()

    _app.state.typed = make_app_state(
        session_factory=_make_db_session_factory(),
        session_service=mock_session_svc,
        pg_pool=MagicMock(),
    )

    # dependency_overrides for the middleware's get_session_service
    _app.dependency_overrides[get_settings] = lambda: _make_settings()
    _app.dependency_overrides[get_session_service] = lambda: mock_session_svc

    return _app


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


AUTH = {"Authorization": "Bearer test-token-64chars-xxx"}


# ── DELETE /api/v1/me/data ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_my_data_returns_204(app, client):
    mock_saver = MagicMock()
    mock_saver.alist = MagicMock(return_value=_empty_aiter())
    mock_saver.adelete_thread = AsyncMock()

    with patch("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", return_value=mock_saver):
        resp = await client.delete("/api/v1/me/data", headers=AUTH)

    assert resp.status_code == 204
    app.state.typed.session_service.revoke.assert_called_once_with("test-token-64chars-xxx")


@pytest.mark.asyncio
async def test_delete_my_data_deletes_matching_checkpoints(app, client):
    user_id = "abc123def456abc123def456abc12345"

    mock_saver = MagicMock()
    mock_saver.alist = MagicMock(return_value=_one_thread_aiter(user_id))
    mock_saver.adelete_thread = AsyncMock()

    with patch("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", return_value=mock_saver):
        resp = await client.delete("/api/v1/me/data", headers=AUTH)

    assert resp.status_code == 204
    mock_saver.adelete_thread.assert_called_once_with(f"{user_id}:wp-rocket:standard")


@pytest.mark.asyncio
async def test_delete_my_data_requires_auth(client):
    resp = await client.delete("/api/v1/me/data")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_delete_my_data_invalid_token_returns_401(app, client):
    mock_session_svc = AsyncMock()
    mock_session_svc.validate = AsyncMock(return_value=None)
    app.dependency_overrides[get_session_service] = lambda: mock_session_svc

    resp = await client.delete("/api/v1/me/data", headers={"Authorization": "Bearer invalid"})
    assert resp.status_code == 401


# ── POST /api/v1/me/data/erase ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_erase_my_data_returns_204(app, client):
    mock_saver = MagicMock()
    mock_saver.alist = MagicMock(return_value=_empty_aiter())
    mock_saver.adelete_thread = AsyncMock()

    with patch("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", return_value=mock_saver):
        resp = await client.post("/api/v1/me/data/erase", headers=AUTH)

    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_erase_deletes_credentials_and_revokes_session(app, client):
    """WPIN-8560: erasure must remove site_credentials AND revoke the session, not just checkpoints."""
    mock_saver = MagicMock()
    mock_saver.alist = MagicMock(return_value=_empty_aiter())
    mock_saver.adelete_thread = AsyncMock()

    with patch("langgraph.checkpoint.postgres.aio.AsyncPostgresSaver", return_value=mock_saver):
        resp = await client.delete("/api/v1/me/data", headers=AUTH)

    assert resp.status_code == 204
    # site_credentials deletion runs through the DB session factory (a delete() execute)
    db_session = app.state.typed.session_factory.return_value
    assert db_session.execute.await_count >= 1
    # session is revoked
    app.state.typed.session_service.revoke.assert_called_once_with("test-token-64chars-xxx")
