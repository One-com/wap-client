"""
Tests for the health/liveness endpoints.

/livez is a static liveness check (no dependencies).
/health is a readiness check that pings Redis + Postgres and returns 503 if
either is down, so an unhealthy pod is pulled from the Service.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy.exc import OperationalError

from app.routes.health import router as health_router
from tests.conftest import make_app_state


def _make_app(redis_ok: bool = True, db_ok: bool = True, pubsub_ok: bool = True) -> FastAPI:
    app = FastAPI()
    app.include_router(health_router)

    # Mock Redis: ping() succeeds or raises a RedisError (the readiness handler
    # only treats RedisError as "down"; anything else is a bug and propagates).
    redis = MagicMock()
    if redis_ok:
        redis.ping = AsyncMock(return_value=True)
    else:
        redis.ping = AsyncMock(side_effect=RedisConnectionError("redis down"))

    # Mock SQLAlchemy async engine: engine.connect() is an async context manager
    # yielding a connection whose execute() succeeds or raises a SQLAlchemyError.
    conn = AsyncMock()
    if not db_ok:
        conn.execute = AsyncMock(side_effect=OperationalError("SELECT 1", {}, Exception("db down")))

    @asynccontextmanager
    async def _connect():
        yield conn

    engine = MagicMock()
    engine.connect = _connect

    # Mock AgentRegistry: pubsub_healthy is a property — use PropertyMock.
    agent_registry = MagicMock()
    type(agent_registry).pubsub_healthy = PropertyMock(return_value=pubsub_ok)

    app.state.typed = make_app_state(redis=redis, engine=engine, agent_registry=agent_registry)

    return app


def test_livez_is_static_ok():
    app = _make_app()
    with TestClient(app) as client:
        resp = client.get("/livez")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_health_ok_when_deps_up():
    app = _make_app(redis_ok=True, db_ok=True, pubsub_ok=True)
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"] == {"redis": "ok", "postgres": "ok", "agent_pubsub": "ok"}


def test_health_503_when_redis_down():
    app = _make_app(redis_ok=False, db_ok=True, pubsub_ok=True)
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["checks"]["redis"].startswith("error")
    assert body["checks"]["postgres"] == "ok"


def test_health_503_when_db_down():
    app = _make_app(redis_ok=True, db_ok=False, pubsub_ok=True)
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["checks"]["redis"] == "ok"
    assert body["checks"]["postgres"].startswith("error")


def test_health_503_when_pubsub_stale():
    app = _make_app(redis_ok=True, db_ok=True, pubsub_ok=False)
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["checks"]["redis"] == "ok"
    assert body["checks"]["postgres"] == "ok"
    assert body["checks"]["agent_pubsub"].startswith("error")


@pytest.mark.parametrize("path", ["/health", "/livez"])
def test_endpoints_have_timestamp(path):
    app = _make_app()
    with TestClient(app) as client:
        resp = client.get(path)
    assert "timestamp" in resp.json()


def test_health_non_dependency_error_is_not_masked():
    """A wiring bug (not a RedisError/SQLAlchemyError) must surface, not be
    silently reported as a routine 'dependency down'."""
    app = _make_app()
    app.state.typed.redis.ping = AsyncMock(side_effect=AttributeError("misconfigured client"))
    with TestClient(app, raise_server_exceptions=True) as client:
        with pytest.raises(AttributeError):
            client.get("/health")
