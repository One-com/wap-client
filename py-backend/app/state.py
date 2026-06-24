"""
Typed application state.

FastAPI's ``app.state`` is dynamically typed (``Any``), so every
``request.app.state.X`` access loses type information and forces a
``# type: ignore[no-any-return]`` on each dependency provider.

``AppState`` declares the shape once. The lifespan in ``main.py`` populates it
and stores it on ``app.state.typed``; ``get_state()`` returns it with the single
unavoidable cast living here instead of scattered across every accessor.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, cast

from fastapi import Request

if TYPE_CHECKING:
    from fastapi.templating import Jinja2Templates
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg_pool import AsyncConnectionPool
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

    from app.config import Settings
    from app.services.admin_session_service import AdminSessionService
    from app.services.agent_registry import AgentRegistry
    from app.services.license_verifier import LicenseVerifierFactory
    from app.services.rate_limiter import RateLimiter
    from app.services.session_service import SessionService
    from app.services.site_allowlist_service import SiteAllowlistService
    from app.services.summarizer import ConversationSummarizer
    from app.services.wp_connection_service import WpConnectionService


@dataclass
class AppState:  # pylint: disable=too-many-instance-attributes
    """Everything wired once in the lifespan and read by request handlers.

    This is a deliberate aggregate of every app-wide singleton, so the attribute
    count is expected to exceed pylint's default.
    """

    settings: "Settings"
    engine: "AsyncEngine"
    session_factory: "async_sessionmaker[AsyncSession]"
    pg_pool: "AsyncConnectionPool"
    checkpointer: "AsyncPostgresSaver"
    redis: "Redis"
    session_service: "SessionService"
    admin_session_service: "AdminSessionService"
    license_verifier: "LicenseVerifierFactory"
    agent_registry: "AgentRegistry"
    rate_limiter: "RateLimiter"
    wp_connection_service: "WpConnectionService"
    site_allowlist_service: "SiteAllowlistService"
    templates: "Jinja2Templates"
    langfuse_handler: object | None = None
    summarizer: "ConversationSummarizer | None" = None


def get_state(request: Request) -> AppState:
    """Return the typed application state.

    The lone cast here replaces a ``# type: ignore`` on every state accessor.
    """
    return cast(AppState, request.app.state.typed)
