"""
FastAPI dependency providers — one function per service stored at startup.

Each provider reads from the typed AppState (see app/state.py), which the
lifespan wires onto request.app.state.typed.  Returning typed fields means no
per-accessor casts: the single cast lives in app.state.get_state().

Tests override individual services via app.dependency_overrides:
    app.dependency_overrides[get_checkpointer] = lambda: mock_checkpointer
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.services.agent_registry import AgentRegistry
from app.services.license_verifier import LicenseVerifierFactory
from app.services.rate_limiter import RateLimiter
from app.services.session_service import SessionService
from app.services.site_allowlist_service import SiteAllowlistService
from app.services.wp_connection_service import WpConnectionService
from app.state import get_state

if TYPE_CHECKING:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    from app.services.summarizer import ConversationSummarizer


def get_settings(request: Request) -> Settings:
    return get_state(request).settings


def get_session_factory(request: Request) -> async_sessionmaker[AsyncSession]:
    return get_state(request).session_factory


async def get_checkpointer(request: Request) -> "AsyncPostgresSaver":
    # A new instance per request gives each request its own asyncio.Lock.
    # The shared pool on app.state is still reused for actual DB connections.
    # Sharing one AsyncPostgresSaver instance across concurrent requests causes
    # all DB operations to serialize through a single lock, deadlocking the backend.
    # Deferred: new instance per request (own asyncio.Lock); langgraph is also a heavy optional dep.
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver  # pylint: disable=import-outside-toplevel

    return AsyncPostgresSaver(get_state(request).pg_pool)  # type: ignore[arg-type]


def get_session_service(request: Request) -> SessionService:
    return get_state(request).session_service


def get_license_verifier(request: Request) -> LicenseVerifierFactory:
    return get_state(request).license_verifier


def get_agent_registry(request: Request) -> AgentRegistry:
    return get_state(request).agent_registry


def get_site_allowlist_service(request: Request) -> SiteAllowlistService:
    return get_state(request).site_allowlist_service


def get_rate_limiter(request: Request) -> RateLimiter:
    return get_state(request).rate_limiter


def get_wp_connection_service(request: Request) -> WpConnectionService:
    return get_state(request).wp_connection_service


def get_langfuse_handler(request: Request) -> object | None:
    return get_state(request).langfuse_handler


def get_summarizer(request: Request) -> "ConversationSummarizer | None":
    return get_state(request).summarizer
