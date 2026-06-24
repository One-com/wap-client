"""
Tests for the site_url allowlist gate.

Two layers:
  - unit: the pure _match/_normalize matching logic and is_allowed fail-closed.
  - route: POST /api/v1/auth/session honoring AUTH_SITE_ALLOWLIST_ENABLED, including
    the interaction with DEV_BYPASS_LICENSE (allowlist enforced regardless of bypass).
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
from app.db.database import _prepare_asyncpg_url  # noqa: F401  (ensures app package importable)
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
from app.services.site_allowlist_service import SiteAllowlistService, _match, _normalize

# ── Unit: matching logic ──────────────────────────────────────────────────────


def test_normalize_drops_path_and_lowercases():
    assert _normalize("https://Example.com/wp-json/") == "https://example.com"
    assert _normalize("https://example.com") == "https://example.com"


def test_match_wildcard_subdomain():
    assert _match("https://*.example.com", "https://a.example.com")
    assert _match("https://*.example.com", "https://a.example.com/some/path")
    assert not _match("https://*.example.com", "https://example.com")  # bare apex not matched by *.
    assert not _match("https://*.example.com", "https://evil.com")


def test_match_exact():
    assert _match("https://my.site", "https://my.site")
    assert _match("https://my.site", "https://my.site/")  # trailing slash normalized away
    assert not _match("https://my.site", "https://other.site")


class _FakeFactory:
    """async_sessionmaker stand-in returning a session whose execute() yields rows."""

    def __init__(self, rows):
        self._rows = rows

    def __call__(self):
        scalars = MagicMock()
        scalars.all = MagicMock(return_value=self._rows)
        result = MagicMock()
        result.scalars = MagicMock(return_value=scalars)
        session = AsyncMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        session.execute = AsyncMock(return_value=result)
        return session


def _entry(pattern: str):
    e = MagicMock()
    e.pattern = pattern
    return e


@pytest.mark.asyncio
async def test_is_allowed_fail_closed_on_empty():
    svc = SiteAllowlistService(_FakeFactory([]))
    assert await svc.is_allowed("https://anything.com") is False


@pytest.mark.asyncio
async def test_is_allowed_matches_pattern():
    svc = SiteAllowlistService(_FakeFactory([_entry("https://*.example.com")]))
    assert await svc.is_allowed("https://a.example.com") is True
    assert await svc.is_allowed("https://evil.com") is False


# ── Route: session creation gate ──────────────────────────────────────────────


@asynccontextmanager
async def _noop_lifespan(app):
    yield


def _make_settings(**overrides) -> Settings:
    base = dict(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        SESSION_ENCRYPTION_KEY="dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=True,
        ENV="test",
    )
    base.update(overrides)
    return Settings(**base)


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


def _build_app(*, allowlist_enabled: bool, allowed: bool, bypass: bool = True):
    app = create_app(app_lifespan=_noop_lifespan)

    mock_verifier = AsyncMock()
    res = MagicMock()
    res.valid = True
    res.user_id = "abc123def456abc123def456abc12345"
    mock_verifier.verify = AsyncMock(return_value=res)

    mock_session_svc = AsyncMock()
    mock_session_svc.create = AsyncMock(return_value="test-token")
    mock_session_svc.validate = AsyncMock(return_value=_make_session_data())

    mock_registry = MagicMock()
    mock_registry.get_by_role = MagicMock(return_value=MagicMock(id="a", name="A", model="claude-sonnet-4-6"))

    mock_allowlist = AsyncMock()
    mock_allowlist.is_allowed = AsyncMock(return_value=allowed)

    app.dependency_overrides[get_settings] = lambda: _make_settings(
        AUTH_SITE_ALLOWLIST_ENABLED=allowlist_enabled, DEV_BYPASS_LICENSE=bypass
    )
    app.dependency_overrides[get_license_verifier] = lambda: mock_verifier
    app.dependency_overrides[get_session_service] = lambda: mock_session_svc
    app.dependency_overrides[get_agent_registry] = lambda: mock_registry
    app.dependency_overrides[get_session_factory] = lambda: _make_db_session_factory()
    app.dependency_overrides[get_site_allowlist_service] = lambda: mock_allowlist
    return app


@pytest_asyncio.fixture
async def _client_factory():
    clients = []

    async def _make(**kwargs):
        app = _build_app(**kwargs)
        ac = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(ac)
        return ac

    yield _make
    for ac in clients:
        await ac.aclose()


_WP_USERS_ME_URL = "https://example.com/wp-json/wp/v2/users/me"


@pytest.mark.asyncio
@respx.mock
async def test_flag_off_skips_allowlist(_client_factory):
    respx.get(_WP_USERS_ME_URL).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    # Even with allowed=False, flag OFF means no allowlist effect → 200.
    client = await _client_factory(allowlist_enabled=False, allowed=False)
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200


@pytest.mark.asyncio
@respx.mock
async def test_flag_on_match_allows(_client_factory):
    respx.get(_WP_USERS_ME_URL).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    client = await _client_factory(allowlist_enabled=True, allowed=True)
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_flag_on_no_match_403(_client_factory):
    client = await _client_factory(allowlist_enabled=True, allowed=False)
    resp = await client.post("/api/v1/auth/session", json=_auth_body(site_url="https://evil.com"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "site_not_allowed"


@pytest.mark.asyncio
async def test_allowlist_enforced_despite_dev_bypass(_client_factory):
    # DEV_BYPASS_LICENSE on + allowlist on + non-matching site → still 403.
    client = await _client_factory(allowlist_enabled=True, allowed=False, bypass=True)
    resp = await client.post("/api/v1/auth/session", json=_auth_body(site_url="https://evil.com"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "site_not_allowed"


@pytest.mark.asyncio
@respx.mock
async def test_allowlist_match_with_bypass_allows(_client_factory):
    respx.get(_WP_USERS_ME_URL).mock(return_value=httpx.Response(200, json={"id": 1, "name": "admin"}))
    client = await _client_factory(allowlist_enabled=True, allowed=True, bypass=True)
    resp = await client.post("/api/v1/auth/session", json=_auth_body())
    assert resp.status_code == 200
