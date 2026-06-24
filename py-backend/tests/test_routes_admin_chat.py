"""
Route-level integration tests for POST /admin/chat/session (admin chat tester auth).

Mirrors test_routes_auth.py: real app, mocked services via dependency_overrides,
no real Postgres/Redis/HTTP. Verifies admin access control, the per-request
validation bypass (empty WP fields), and full validation when fields are supplied.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import pytest_asyncio
import respx
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.dependencies import (
    get_agent_registry,
    get_license_verifier,
    get_session_factory,
    get_session_service,
    get_settings,
    get_site_allowlist_service,
)
from app.main import create_app
from tests.conftest import make_app_state

_ADMIN_KEY = "test-admin-key"
_AUTH_HEADER = {"Authorization": f"Bearer {_ADMIN_KEY}"}
_WP_USERS_ME_URL = "https://example.com/wp-json/wp/v2/users/me"


@asynccontextmanager
async def _noop_lifespan(_app):
    yield


def _make_settings(**overrides) -> Settings:
    base = dict(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        SESSION_ENCRYPTION_KEY="dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY=_ADMIN_KEY,
        ANTHROPIC_API_KEY="sk-ant-test",
        # Deploy-wide bypass OFF — the admin route must bypass per-request on its own.
        DEV_BYPASS_LICENSE=False,
        ENV="test",
    )
    base.update(overrides)
    return Settings(**base)


def _make_agent():
    agent = MagicMock()
    agent.id = "agent-uuid-1"
    agent.name = "WP Rocket Agent"
    agent.model = "claude-sonnet-4-6"
    return agent


def _make_db_session_factory():
    mock_db = AsyncMock()
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    begin_cm = AsyncMock()
    begin_cm.__aenter__ = AsyncMock(return_value=begin_cm)
    begin_cm.__aexit__ = AsyncMock(return_value=False)
    mock_db.begin = MagicMock(return_value=begin_cm)
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None)))
    mock_db.add = MagicMock()
    return MagicMock(return_value=mock_db)


@pytest_asyncio.fixture
async def app():
    _app = create_app(app_lifespan=_noop_lifespan)

    mock_verifier = AsyncMock()
    mock_verifier.verify = AsyncMock(return_value=MagicMock(valid=True))

    mock_session_svc = AsyncMock()
    mock_session_svc.create = AsyncMock(return_value="test-token-64chars-xxx")

    mock_registry = MagicMock()
    mock_registry.get_by_role = MagicMock(return_value=_make_agent())

    mock_allowlist = AsyncMock()
    mock_allowlist.is_allowed = AsyncMock(return_value=True)

    _app.dependency_overrides[get_settings] = lambda: _make_settings()
    _app.dependency_overrides[get_license_verifier] = lambda: mock_verifier
    _app.dependency_overrides[get_session_service] = lambda: mock_session_svc
    _app.dependency_overrides[get_agent_registry] = lambda: mock_registry
    _app.dependency_overrides[get_session_factory] = lambda: _make_db_session_factory()
    _app.dependency_overrides[get_site_allowlist_service] = lambda: mock_allowlist

    mock_admin_session_svc = AsyncMock(validate=AsyncMock(return_value=None))
    _app.state.typed = make_app_state(
        settings=_make_settings(),
        admin_session_service=mock_admin_session_svc,
    )

    return _app


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_requires_admin_auth(client):
    """Without the admin key, the endpoint is rejected."""
    resp = await client.post("/admin/chat/session", json={"product": "wp-rocket"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_bypass_when_fields_empty(client):
    """Empty WP fields → session minted without any WP REST call."""
    resp = await client.post(
        "/admin/chat/session",
        headers=_AUTH_HEADER,
        json={"product": "wp-rocket", "mode": "product"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"] == "test-token-64chars-xxx"
    assert body["mode"] == "product"
    assert body["conversationId"].endswith(":wp-rocket:standard")
    assert body["agent"]["name"] == "WP Rocket Agent"


@pytest.mark.asyncio
@respx.mock
async def test_full_validation_when_fields_supplied(client):
    """All WP fields present → real WP App Password validation runs."""
    route = respx.get(_WP_USERS_ME_URL).mock(return_value=httpx.Response(200, json={"id": 7, "name": "admin"}))
    resp = await client.post(
        "/admin/chat/session",
        headers=_AUTH_HEADER,
        json={
            "product": "wp-rocket",
            "mode": "product",
            "site_url": "https://example.com",
            "mcp_endpoint": "https://example.com/wp-json/mcp/server",
            "wp_username": "admin",
            "wp_app_password": "abcd abcd abcd abcd abcd abcd",
        },
    )
    assert resp.status_code == 200
    assert route.called  # validation path was exercised
    assert resp.json()["token"] == "test-token-64chars-xxx"


@pytest.mark.asyncio
@respx.mock
async def test_full_validation_bad_password_returns_401(client):
    """Supplied-but-invalid WP App Password is rejected, not bypassed."""
    respx.get(_WP_USERS_ME_URL).mock(return_value=httpx.Response(401))
    resp = await client.post(
        "/admin/chat/session",
        headers=_AUTH_HEADER,
        json={
            "product": "wp-rocket",
            "mode": "product",
            "site_url": "https://example.com",
            "mcp_endpoint": "https://example.com/wp-json/mcp/server",
            "wp_username": "admin",
            "wp_app_password": "wrong",
        },
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "invalid_app_password"
