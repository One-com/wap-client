"""
Pytest fixtures shared across test modules.

Integration tests that need Postgres/Redis use the real services running via
Docker Compose (same as development).  Set DATABASE_URL and REDIS_URL in the
environment before running integration tests.

Unit tests mock all external dependencies.
"""

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

# ── Environment defaults for tests ────────────────────────────────────────────
# These are overridden by the real env when running integration tests.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://wap:wap@localhost:5433/wap")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379")
import base64 as _b64

os.environ.setdefault("SESSION_ENCRYPTION_KEY", _b64.b64encode(b"\xaa" * 32).decode())
os.environ.setdefault("ADMIN_API_KEY", "test-admin-key")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")
os.environ.setdefault("DEV_BYPASS_LICENSE", "true")


@pytest.fixture
def settings():
    from app.config import get_settings

    get_settings.cache_clear()
    return get_settings()


@pytest.fixture
def mock_session_factory():
    """Returns a mock SQLAlchemy async_sessionmaker."""
    factory = MagicMock()
    session = AsyncMock()
    factory.return_value.__aenter__ = AsyncMock(return_value=session)
    factory.return_value.__aexit__ = AsyncMock(return_value=False)
    return factory, session


@pytest.fixture
def mock_redis():
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.delete = AsyncMock(return_value=1)
    redis.expire = AsyncMock(return_value=True)
    redis.incr = AsyncMock(return_value=1)
    redis.expireat = AsyncMock(return_value=True)
    return redis


def make_app_state(**overrides):
    """Build an AppState for tests with MagicMock defaults for every field.

    Production code reads services via app.state.get_state(request), so tests
    that exercise a handler reading state directly must populate app.state.typed.
    Pass only the fields the handler under test actually uses; the rest are
    harmless mocks. Wire it with: app.state.typed = make_app_state(...).
    """
    from app.state import AppState

    fields = {name: MagicMock() for name in AppState.__dataclass_fields__}
    fields.update(overrides)
    return AppState(**fields)
