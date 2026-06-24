"""
FastAPI application — entry point and dependency wiring.

All services are constructed once in the lifespan context manager and stored
in a typed AppState on app.state.typed.  Routes retrieve them via
app.state.get_state(request) or the dependency providers in app.dependencies.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from psycopg_pool import AsyncConnectionPool
from redis.asyncio import Redis

from app.config import get_settings
from app.db.database import create_engine, create_session_factory
from app.lib.agent_pubsub import run_cache_invalidation_subscriber
from app.lib.observability import create_langfuse_handler, init_sentry, setup_prometheus
from app.routes.admin import router as admin_router
from app.routes.admin_chat import router as admin_chat_router
from app.routes.admin_ui import _LoginRedirect
from app.routes.admin_ui import router as admin_ui_router
from app.routes.auth import router as auth_router
from app.routes.chat import router as chat_router
from app.routes.health import router as health_router
from app.routes.me import router as me_router
from app.services.admin_session_service import AdminSessionService
from app.services.agent_registry import AgentRegistry
from app.services.license_verifier import LicenseVerifierFactory
from app.services.rate_limiter import RateLimiter
from app.services.session_service import SessionService
from app.services.site_allowlist_service import SiteAllowlistService
from app.services.summarizer import ConversationSummarizer
from app.services.wp_connection_service import WpConnectionService
from app.state import AppState


def _configure_logging(is_production: bool) -> None:
    """Set up structlog with JSON output in production, pretty console in dev."""
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    renderer: structlog.processors.JSONRenderer | structlog.dev.ConsoleRenderer
    if is_production:
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[*shared_processors, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
        foreign_pre_chain=shared_processors,
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    root_logger = logging.getLogger()
    root_logger.handlers = [handler]
    root_logger.setLevel(logging.INFO)


_configure_logging(is_production=os.environ.get("ENV", "development") == "production")
logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:  # pylint: disable=too-many-locals,too-many-statements,redefined-outer-name
    """Startup: wire all dependencies.  Shutdown: clean up connections."""
    settings = get_settings()

    init_sentry(settings)
    langfuse_handler = create_langfuse_handler(settings)

    # SQLAlchemy engine (for site_credentials, agent registry, etc.)
    engine = create_engine(settings)
    session_factory = create_session_factory(engine)

    # Deferred: langgraph is a heavy optional dependency; keeps startup clean if not installed.
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver  # pylint: disable=import-outside-toplevel

    # Run setup over a direct autocommit connection (CREATE INDEX CONCURRENTLY
    # cannot run inside a transaction block, which psycopg_pool uses by default).
    # UniqueViolation is raised when tables/types already exist (idempotent setup
    # on an existing DB) — safe to ignore.
    try:
        async with AsyncPostgresSaver.from_conn_string(settings.pg_dsn) as setup_checkpointer:
            await setup_checkpointer.setup()
        logger.info("[WAP] LangGraph checkpoint tables ready")
    except Exception as exc:  # pylint: disable=broad-exception-caught
        if "already exists" in str(exc) or "UniqueViolation" in type(exc).__name__:
            logger.info("[WAP] LangGraph checkpoint tables already exist — skipping setup")
        else:
            raise

    def _on_pg_pool_reconnect_failed(_pool: AsyncConnectionPool) -> None:
        logger.error("[WAP] pg_pool: all reconnect attempts failed — checkpointer connections unavailable")

    # Runtime pool — used for all chat requests.
    # min_size=2 pre-warms connections at startup to avoid a burst of concurrent
    # TCP handshakes on the first requests.  max_size=10 matches the SQLAlchemy
    # pool cap so both pools together stay well within Postgres max_connections.
    pg_pool = AsyncConnectionPool(
        conninfo=settings.pg_dsn,
        min_size=2,
        max_size=10,
        open=False,
        reconnect_failed=_on_pg_pool_reconnect_failed,
    )
    await pg_pool.open()
    checkpointer = AsyncPostgresSaver(pg_pool)  # type: ignore[arg-type]
    logger.info("[WAP] LangGraph checkpointer ready")

    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)

    session_service = SessionService(redis)
    admin_session_service = AdminSessionService(redis)
    license_verifier = LicenseVerifierFactory(settings)
    agent_registry = AgentRegistry(
        session_factory,
        redis_client=redis,
        pubsub_staleness_threshold_s=settings.PUBSUB_STALENESS_THRESHOLD_S,
    )
    await agent_registry.load()
    subscriber_task = asyncio.create_task(
        run_cache_invalidation_subscriber(redis, agent_registry),
        name="agent-cache-pubsub",
    )
    agent_registry._subscriber_task = subscriber_task  # pylint: disable=protected-access
    rate_limiter = RateLimiter(redis)
    wp_connection_service = WpConnectionService(settings)
    site_allowlist_service = SiteAllowlistService(session_factory)
    # Pass pg_pool (not checkpointer) so each summarize call gets its own
    # AsyncPostgresSaver instance with its own lock — prevents races with the
    # per-request checkpointer running concurrently on the same thread_id.
    summarizer = ConversationSummarizer(
        agent_registry,
        settings.ANTHROPIC_API_KEY,
        pg_pool,
        message_threshold=settings.SUMMARIZER_MESSAGE_THRESHOLD,
    )

    # Single typed state object — read everywhere via app.state.get_state(request).
    app.state.typed = AppState(
        settings=settings,
        engine=engine,
        session_factory=session_factory,
        pg_pool=pg_pool,
        checkpointer=checkpointer,
        redis=redis,
        session_service=session_service,
        admin_session_service=admin_session_service,
        license_verifier=license_verifier,
        agent_registry=agent_registry,
        rate_limiter=rate_limiter,
        wp_connection_service=wp_connection_service,
        site_allowlist_service=site_allowlist_service,
        templates=Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates")),
        langfuse_handler=langfuse_handler,
        summarizer=summarizer,
    )

    logger.info("[WAP] Python/LangGraph backend started on port %d", settings.PORT)
    yield

    subscriber_task.cancel()
    try:
        await subscriber_task
    except asyncio.CancelledError:
        pass
    await redis.aclose()
    await pg_pool.close()
    await engine.dispose()
    logger.info("[WAP] shutdown complete")


def create_app(app_lifespan: Callable | None = None) -> FastAPI:  # pylint: disable=redefined-outer-name
    settings = get_settings()

    app = FastAPI(  # pylint: disable=redefined-outer-name
        title="WAP — WordPress AI Platform",
        version="0.1.0",
        lifespan=app_lifespan if app_lifespan is not None else lifespan,
    )

    if settings.ALLOWED_ORIGINS:
        allow_origins = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]
    elif settings.is_production:
        allow_origins = []  # No origins allowed until ALLOWED_ORIGINS is configured
        logger.warning(
            "[WAP] CORS: ALLOWED_ORIGINS is not set in production — browser requests will be blocked. "
            "Set ALLOWED_ORIGINS to a comma-separated list of WordPress admin origins."
        )
    else:
        allow_origins = ["*"]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=["Content-Type"],
    )

    setup_prometheus(app, settings)

    app.include_router(health_router)
    app.include_router(auth_router, prefix="/api/v1/auth")
    app.include_router(chat_router, prefix="/api/v1/chat")
    app.include_router(me_router, prefix="/api/v1/me")
    app.include_router(admin_router, prefix="/admin")
    app.include_router(admin_chat_router, prefix="/admin")
    app.include_router(admin_ui_router, prefix="/admin")

    # Static files for admin UI (CSS overrides, etc.)
    _static_dir = os.path.join(os.path.dirname(__file__), "static", "admin")
    app.mount("/admin/static", StaticFiles(directory=_static_dir), name="admin_static")

    @app.exception_handler(_LoginRedirect)
    async def _handle_login_redirect(  # pylint: disable=unused-argument
        _request: Request, _exc: _LoginRedirect
    ) -> RedirectResponse:
        return RedirectResponse(url="/admin/login", status_code=303)

    return app


app = create_app()
