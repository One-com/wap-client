"""
Optional observability integrations: LangFuse, Sentry, Prometheus.

Each integration is opt-in via environment variables:
  - LangFuse:    LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
  - Sentry:      SENTRY_DSN
  - Prometheus:  PROMETHEUS_ENABLED=true

Absent variables disable the integration without any code changes elsewhere.

Possible Prometheus metrics to add in the future (currently auto-instrumented only):
  - wap_agent_invocations_total          Counter   — LangGraph agent calls by agent_id and status
  - wap_agent_duration_seconds           Histogram — end-to-end latency per agent invocation
  - wap_llm_tokens_total                 Counter   — Anthropic tokens consumed (prompt/completion) by agent
  - wap_active_sessions_total            Gauge     — Active WordPress sessions tracked in Redis
  - wap_rate_limit_rejections_total      Counter   — Requests rejected by the rate limiter by reason
  - wap_chat_stream_duration_seconds     Histogram — SSE stream duration (first byte → close)
  - wap_tool_calls_total                 Counter   — MCP/LangChain tool invocations by tool_name and status
  - wap_langgraph_checkpoint_writes_total Counter  — LangGraph Postgres checkpoint writes
  - wap_db_pool_size                     Gauge     — asyncpg connection pool utilisation
  - wap_redis_errors_total               Counter   — Redis operation errors by operation
"""

from __future__ import annotations

import logging

from fastapi import FastAPI

from app.config import Settings

logger = logging.getLogger(__name__)


def create_langfuse_handler(settings: Settings) -> object | None:
    """Return a LangFuse CallbackHandler, or None if not configured."""
    if not settings.LANGFUSE_PUBLIC_KEY or not settings.LANGFUSE_SECRET_KEY:
        logger.info("[observability] LangFuse tracing disabled (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set)")
        return None

    try:
        # Deferred: langfuse is optional; absent package is caught below so startup is unaffected.
        from langfuse import Langfuse  # pylint: disable=import-outside-toplevel
        from langfuse.langchain import CallbackHandler  # pylint: disable=import-outside-toplevel

        # Langfuse v3+: the CallbackHandler binds to the configured singleton
        # client, so credentials and host must be set on the Langfuse() client
        # (passing them to CallbackHandler is no longer supported).
        Langfuse(
            public_key=settings.LANGFUSE_PUBLIC_KEY,
            secret_key=settings.LANGFUSE_SECRET_KEY,
            host=settings.LANGFUSE_BASE_URL,
        )
        handler = CallbackHandler()
        logger.info("[observability] LangFuse tracing enabled (host: %s)", settings.LANGFUSE_BASE_URL)
        return handler
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.warning("[observability] Failed to initialise LangFuse: %s", exc)
        return None


def init_sentry(settings: Settings) -> None:
    """Initialise Sentry SDK if SENTRY_DSN is set."""
    if not settings.SENTRY_DSN:
        logger.info("[observability] Sentry disabled (SENTRY_DSN not set)")
        return

    try:
        # Deferred: sentry_sdk is optional; absent package is caught below so startup is unaffected.
        import sentry_sdk  # pylint: disable=import-outside-toplevel
        from sentry_sdk.integrations.fastapi import FastApiIntegration  # pylint: disable=import-outside-toplevel
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration  # pylint: disable=import-outside-toplevel

        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            environment=settings.ENV,
            traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
            integrations=[
                FastApiIntegration(),
                SqlalchemyIntegration(),
            ],
            # Avoid leaking sensitive headers in Sentry breadcrumbs
            send_default_pii=False,
        )
        logger.info("[observability] Sentry enabled (environment: %s)", settings.ENV)
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.warning("[observability] Failed to initialise Sentry: %s", exc)


def setup_prometheus(app: FastAPI, settings: Settings) -> None:
    """Attach prometheus-fastapi-instrumentator to the app if enabled."""
    if not settings.PROMETHEUS_ENABLED:
        logger.info("[observability] Prometheus metrics disabled (PROMETHEUS_ENABLED not set)")
        return

    try:
        # Deferred: prometheus_fastapi_instrumentator is optional; absent package caught below.
        from prometheus_fastapi_instrumentator import Instrumentator  # pylint: disable=import-outside-toplevel

        Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            excluded_handlers=["/health", "/livez", "/metrics"],
        ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)

        logger.info("[observability] Prometheus metrics exposed at /metrics")
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.warning("[observability] Failed to initialise Prometheus: %s", exc)
