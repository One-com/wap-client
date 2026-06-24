"""
Route-level integration tests for POST /api/v1/auth/session and DELETE /api/v1/auth/session.

Uses FastAPI's dependency_overrides to inject mock services — no real Postgres,
Redis, or external HTTP calls. The full request/response cycle (routing, schema
validation, status codes, response shape) is exercised against the real app.
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
from app.services.session_service import SessionData

# ── Fixtures ──────────────────────────────────────────────────────────────────


@asynccontextmanager
async def _noop_lifespan(app):
    yield


_WP_USERS_ME_DEFAULT = "https://example.com/wp-json/wp/v2/users/me"


def _make_settings(**overrides) -> Settings:
    base = dict(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        # base64("testkeytestkeytestkeytestkey1234") — exactly 32 bytes for AES-256
        SESSION_ENCRYPTION_KEY="dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=True,  # bypass license check only; WP check is mocked separately
        ENV="test",
    )
    base.update(overrides)
    return Settings(**base)


def _make_license_result(valid: bool = True):
    result = MagicMock()
    result.valid = valid
    result.user_id = "abc123def456abc123def456abc12345"
    return result


def _make_agent():
    agent = MagicMock()
    agent.id = "agent-uuid-1"
    agent.name = "WP Rocket Agent"
    agent.model = "claude-sonnet-4-6"
    return agent


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
    # begin() must also work as an async context manager for `async with db_session.begin()`
    begin_cm = AsyncMock()
    begin_cm.__aenter__ = AsyncMock(return_value=begin_cm)
    begin_cm.__aexit__ = AsyncMock(return_value=False)
    mock_db.begin = MagicMock(return_value=begin_cm)
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None)))
    mock_db.add = MagicMock()
    return MagicMock(return_value=mock_db)


@pytest_asyncio.fixture
async def app():
    """FastAPI app with no-op lifespan and all services mocked via dependency_overrides.

    The default /wp-json/wp/v2/users/me call is intercepted by respx so tests that
    don't care about WP credential validation don't make real HTTP requests.
    Tests exercising the WP validation path set up their own respx mocks explicitly.
    """
    _app = create_app(app_lifespan=_noop_lifespan)

    mock_verifier = AsyncMock()
    mock_verifier.verify = AsyncMock(return_value=_make_license_result(valid=True))

    mock_session_svc = AsyncMock()
    mock_session_svc.create = AsyncMock(return_value="test-token-64chars-xxx")
    mock_session_svc.validate = AsyncMock(return_value=_make_session_data())
    mock_session_svc.revoke = AsyncMock()

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

    return _app


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


# ── Auth body helpers ─────────────────────────────────────────────────────────


def _auth_body(**overrides) -> dict:
    base = {
        "product": "wp-rocket",
        "license_key": "valid-key",
        "site_url": "https://example.com",
        "mcp_endpoint": "https://example.com/wp-json/mcp/server",
        "wp_username": "admin",
        "wp_app_password": "abcd efgh ijkl mnop",
    }
    base.update(overrides)
    return base


# ── POST /api/v1/auth/session ─────────────────────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_create_session_success(client):
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200
    data = resp.json()
    assert "token" in data
    assert data["ttl"] == 3600
    assert data["mode"] == "product"
    assert "conversationId" in data


@pytest.mark.asyncio
async def test_create_session_missing_required_field(client):
    body = _auth_body()
    del body["wp_username"]
    resp = await client.post("/api/v1/auth/session", json=body)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_session_empty_product(client):
    resp = await client.post("/api/v1/auth/session", json=_auth_body(product=""))
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_session_invalid_license(app, client):
    mock_verifier = AsyncMock()
    mock_verifier.verify = AsyncMock(return_value=_make_license_result(valid=False))
    app.dependency_overrides[get_license_verifier] = lambda: mock_verifier
    app.dependency_overrides[get_settings] = lambda: _make_settings(DEV_BYPASS_LICENSE=False)

    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "license_invalid"


@pytest.mark.asyncio
async def test_create_session_unknown_product(app, client):
    mock_verifier = AsyncMock()
    mock_verifier.verify = AsyncMock(side_effect=ValueError("Unknown product"))
    app.dependency_overrides[get_license_verifier] = lambda: mock_verifier
    app.dependency_overrides[get_settings] = lambda: _make_settings(DEV_BYPASS_LICENSE=False)

    resp = await client.post("/api/v1/auth/session", json=_auth_body(product="unknown-product"))
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "unknown_product"


@pytest.mark.asyncio
@respx.mock
async def test_create_session_no_agent_for_product(app, client):
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    mock_registry = MagicMock()
    mock_registry.get_by_role = MagicMock(return_value=None)
    app.dependency_overrides[get_agent_registry] = lambda: mock_registry

    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "no_agent"


@pytest.mark.asyncio
@respx.mock
async def test_create_session_orchestrator_mode(client):
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    body = _auth_body(mode="orchestrator", available_products=["wp-rocket", "rankmath"])
    resp = await client.post("/api/v1/auth/session", json=body)
    assert resp.status_code == 200
    assert resp.json()["mode"] == "orchestrator"


@pytest.mark.asyncio
@respx.mock
async def test_create_session_orchestrator_mode_no_available_products(client):
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    # available_products omitted in orchestrator mode → falls back to [body.product]
    body = _auth_body(mode="orchestrator")
    resp = await client.post("/api/v1/auth/session", json=body)
    assert resp.status_code == 200
    assert resp.json()["mode"] == "orchestrator"


@pytest.mark.asyncio
@respx.mock
async def test_create_session_upserts_existing_credential(app, client):
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    # execute() returns an existing credential → update branch runs (no db.add call)
    existing_cred = MagicMock()
    existing_cred.encrypted_wp_app_password = "old"
    existing_cred.wp_username = "old_user"
    existing_cred.mcp_endpoint = "https://example.com/old"

    mock_db = AsyncMock()
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    begin_cm = AsyncMock()
    begin_cm.__aenter__ = AsyncMock(return_value=begin_cm)
    begin_cm.__aexit__ = AsyncMock(return_value=False)
    mock_db.begin = MagicMock(return_value=begin_cm)
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=existing_cred)))
    mock_db.add = MagicMock()
    app.dependency_overrides[get_session_factory] = lambda: MagicMock(return_value=mock_db)

    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200
    # credential was updated in-place, not re-added
    mock_db.add.assert_not_called()
    assert existing_cred.wp_username == "admin"
    assert existing_cred.mcp_endpoint == "https://example.com/wp-json/mcp/server"


# ── WP App Password validation (DEV_BYPASS_LICENSE=False path) ────────────────


def _no_bypass_app(base_app):
    """Switch the app fixture to bypass=False so _validate_wp_app_password runs."""
    base_app.dependency_overrides[get_settings] = lambda: _make_settings(DEV_BYPASS_LICENSE=False)
    return base_app


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_success(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(200, json={"id": 42, "name": "admin"}))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200
    assert "token" in resp.json()


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_401_returns_401(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(401))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "invalid_app_password"


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_5xx_returns_502(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(return_value=httpx.Response(500))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "wp_error"


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_timeout_returns_502(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(side_effect=httpx.TimeoutException("timed out"))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "wp_timeout"


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_network_error_returns_502(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(side_effect=httpx.ConnectError("refused"))
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "wp_unreachable"


@pytest.mark.asyncio
@respx.mock
async def test_wp_app_password_missing_id_returns_502(app, client):
    _no_bypass_app(app)
    respx.get(_WP_USERS_ME_DEFAULT).mock(
        return_value=httpx.Response(200, json={"name": "admin"})  # no "id" field
    )
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "wp_bad_response"


# ── DELETE /api/v1/auth/session ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revoke_session_success(client):
    resp = await client.delete(
        "/api/v1/auth/session",
        headers={"Authorization": "Bearer test-token-64chars-xxx"},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_revoke_session_no_token(client):
    resp = await client.delete("/api/v1/auth/session")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_revoke_session_invalid_token(app, client):
    # get_session dependency rejects an unrecognised token → 401
    mock_session_svc = AsyncMock()
    mock_session_svc.validate = AsyncMock(return_value=None)  # token not found in Redis
    mock_session_svc.revoke = AsyncMock()
    app.dependency_overrides[get_session_service] = lambda: mock_session_svc

    resp = await client.delete(
        "/api/v1/auth/session",
        headers={"Authorization": "Bearer invalid-or-expired-token"},
    )
    assert resp.status_code == 401
