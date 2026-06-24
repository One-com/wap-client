"""
Unit tests for SessionService — token creation, validation, revocation.
"""

import json
from unittest.mock import AsyncMock

import pytest

from app.services.session_service import SESSION_TTL, SessionData, SessionService, _hash, _key


def _sample_session() -> SessionData:
    return SessionData(
        user_id="abc123",
        product="wp-rocket",
        site_url="https://example.com",
        mcp_endpoint="https://example.com/wp-json/mcp/server",
        mode="product",
        available_products=["wp-rocket"],
        created_at=1700000000000,
    )


def test_session_data_round_trip():
    s = _sample_session()
    d = s.to_dict()
    s2 = SessionData.from_dict(d)
    assert s2.user_id == s.user_id
    assert s2.product == s.product
    assert s2.mode == s.mode
    assert s2.available_products == s.available_products


def test_session_data_no_agent_id():
    """SessionData must NOT have an agent_id field (resolved at chat time)."""
    s = _sample_session()
    assert not hasattr(s, "agent_id")
    d = s.to_dict()
    assert "agentId" not in d


@pytest.mark.asyncio
async def test_create_stores_in_redis():
    redis = AsyncMock()
    redis.set = AsyncMock(return_value=True)

    svc = SessionService(redis)
    token = await svc.create(_sample_session())

    assert len(token) == 64  # token_hex(32) = 64 chars
    redis.set.assert_called_once()
    call_args = redis.set.call_args
    stored_key = call_args[0][0]
    assert stored_key == f"session:{_hash(token)}"
    assert call_args[1]["ex"] == SESSION_TTL  # 600s


@pytest.mark.asyncio
async def test_validate_returns_session_on_hit():
    session = _sample_session()
    raw = json.dumps(session.to_dict())

    redis = AsyncMock()
    redis.get = AsyncMock(return_value=raw)

    svc = SessionService(redis)
    result = await svc.validate("some-token")

    assert result is not None
    assert result.user_id == session.user_id
    redis.expire.assert_not_called()  # fixed TTL, no sliding expiry


@pytest.mark.asyncio
async def test_validate_returns_none_on_miss():
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    svc = SessionService(redis)
    result = await svc.validate("nonexistent-token")
    assert result is None


@pytest.mark.asyncio
async def test_revoke_deletes_key():
    redis = AsyncMock()
    redis.delete = AsyncMock(return_value=1)

    svc = SessionService(redis)
    await svc.revoke("some-token")

    redis.delete.assert_called_once_with(_key("some-token"))


@pytest.mark.asyncio
async def test_validate_returns_none_after_revoke():
    """WPIN-8559: once a token is revoked, subsequent validate() returns None (→ 401)."""

    # In-memory Redis stub keyed exactly like SessionService.
    store: dict[str, str] = {}

    redis = AsyncMock()

    async def _set(key, value, ex=None):  # noqa: ANN001, ARG001
        store[key] = value
        return True

    async def _get(key):  # noqa: ANN001
        return store.get(key)

    async def _delete(key):  # noqa: ANN001
        return 1 if store.pop(key, None) is not None else 0

    redis.set = AsyncMock(side_effect=_set)
    redis.get = AsyncMock(side_effect=_get)
    redis.delete = AsyncMock(side_effect=_delete)

    svc = SessionService(redis)
    token = await svc.create(_sample_session())

    # Valid before revoke
    assert await svc.validate(token) is not None

    # Revoke, then it must no longer validate
    await svc.revoke(token)
    assert await svc.validate(token) is None
