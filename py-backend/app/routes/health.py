from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response, status
from redis.exceptions import RedisError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.state import get_state

router = APIRouter()


@router.get("/livez")
async def livez() -> dict[str, str]:
    """Liveness probe: process is up and serving HTTP. No dependency checks, so a
    transient Redis/Postgres blip never causes Kubernetes to restart the pod."""
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/health")
async def health(request: Request, response: Response) -> dict[str, object]:
    """Readiness probe: verifies Redis and Postgres are reachable.

    Returns 200 only when both dependencies respond; otherwise 503 so the pod is
    pulled from the Service (but not killed — that's /livez's job).
    """
    state = get_state(request)
    checks: dict[str, str] = {}
    healthy = True

    # Redis PING. Narrow to RedisError so a real wiring bug (e.g. misconfigured
    # client raising AttributeError/TypeError) surfaces loudly instead of being
    # reported as a routine "dependency down".
    try:
        await state.redis.ping()
        checks["redis"] = "ok"
    except RedisError as exc:
        checks["redis"] = f"error: {exc}"
        healthy = False

    # Postgres SELECT 1 (SQLAlchemy async engine). Narrow to SQLAlchemyError for
    # the same reason — only genuine DB connectivity/query errors mark unhealthy.
    try:
        async with state.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except SQLAlchemyError as exc:
        checks["postgres"] = f"error: {exc}"
        healthy = False

    # Agent cache pub/sub subscriber (cross-pod cache invalidation)
    if not state.agent_registry.pubsub_healthy:
        checks["agent_pubsub"] = "error: subscriber not running or stale"
        healthy = False
    else:
        checks["agent_pubsub"] = "ok"

    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": "ok" if healthy else "unhealthy",
        "checks": checks,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
