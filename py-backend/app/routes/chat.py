"""
Chat routes.

POST /chat/stream
  SSE streaming chat.  Agent is resolved from the registry at request time —
  not baked into the session — so live agent swaps take effect immediately.

GET /chat/{thread_id}/history
  Conversation history from LangGraph checkpoint store.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.db.models import SiteCredential
from app.dependencies import (
    get_agent_registry,
    get_checkpointer,
    get_langfuse_handler,
    get_rate_limiter,
    get_session_factory,
    get_settings,
    get_summarizer,
    get_wp_connection_service,
)
from app.lib.encryption import decrypt
from app.lib.request_context import RequestContext
from app.lib.sse import SSE_HEADERS, format_sse, format_sse_done
from app.middleware.session_auth import get_session
from app.services.agent_registry import AgentRegistry
from app.services.rate_limiter import RateLimiter
from app.services.session_service import SessionData
from app.services.wp_connection_service import WpConnectionService

if TYPE_CHECKING:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    from app.services.summarizer import ConversationSummarizer

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatBody(BaseModel):
    message: str = Field(min_length=1)
    page_context: str | None = Field(default=None, min_length=1, max_length=64)


async def _get_credentials(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    session: SessionData,
) -> tuple[str | None, str | None]:
    """Load decrypted WP App Password for this session from Postgres."""
    async with session_factory() as db_session:
        result = await db_session.execute(
            select(SiteCredential)
            .where(
                and_(
                    SiteCredential.user_id == session.user_id,
                    SiteCredential.site_url == session.site_url,
                    SiteCredential.product == session.product,
                )
            )
            .limit(1)
        )
        cred = result.scalar_one_or_none()

    if not cred:
        return None, None

    app_password = decrypt(cred.encrypted_wp_app_password, settings.SESSION_ENCRYPTION_KEY)
    return cred.wp_username, app_password


@router.post("/stream")
async def chat_stream(  # pylint: disable=too-many-arguments,too-many-positional-arguments
    body: ChatBody,
    session: SessionData = Depends(get_session),
    settings: Settings = Depends(get_settings),
    rate_limiter: RateLimiter = Depends(get_rate_limiter),
    agent_registry: AgentRegistry = Depends(get_agent_registry),
    checkpointer: "AsyncPostgresSaver" = Depends(get_checkpointer),
    wp_connection_service: WpConnectionService = Depends(get_wp_connection_service),
    langfuse_handler: object = Depends(get_langfuse_handler),
    summarizer: "ConversationSummarizer | None" = Depends(get_summarizer),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_session_factory),
) -> StreamingResponse:
    rl = await rate_limiter.check(session.user_id)
    if not rl.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"error": "rate_limit_exceeded", "resetAt": rl.reset_at},
        )

    async def generate() -> AsyncGenerator[str, None]:
        try:
            # Deferred: chat.py → single_agent.py → tools.py → chat.py would circular-import at module level.
            from app.agents.single_agent import SingleAgentGraph  # pylint: disable=import-outside-toplevel
            from app.lib.tools import build_contextual_tools  # pylint: disable=import-outside-toplevel

            wp_username, app_password = await _get_credentials(session_factory, settings, session)
            wp_username = wp_username or ""
            app_password = app_password or ""

            # Resolve agent at chat time (not from session) so live swaps take effect
            role = agent_registry.role_for_session(session, page_context=body.page_context)
            agent = agent_registry.get_by_role(role)
            if not agent:
                yield format_sse({"type": "error", "message": f"No active agent for role: {role}"})
                yield format_sse_done()
                return

            thread_id = f"{session.user_id}:{role}"
            yield format_sse({"type": "message_start", "conversationId": thread_id, "mode": session.mode})

            # Per-request credentials + routing context, shared by the tools and the graph.
            context = RequestContext(
                user_id=session.user_id,
                mcp_endpoint=session.mcp_endpoint,
                site_url=session.site_url,
                cred_username=wp_username,
                cred_app_password=app_password,
                langfuse_handler=langfuse_handler,
            )

            contextual_tools = build_contextual_tools(
                agent.tools,
                registry=agent_registry,
                api_key=settings.ANTHROPIC_API_KEY,
                wp_connection_service=wp_connection_service,
                available_products=session.available_products or [],
                context=context,
            )
            graph = SingleAgentGraph(
                agent_def=agent,
                api_key=settings.ANTHROPIC_API_KEY,
                wp_connection_service=wp_connection_service,
                checkpointer=checkpointer,
                summarizer=summarizer,
                extra_tools=list(contextual_tools.values()),
            )
            # Per-trace attribution for LangFuse (product cost / per-agent monitoring).
            trace_metadata = {
                "user_id": session.user_id,
                "product": session.product,
                "mode": session.mode,
            }
            async for chunk in graph.stream(
                role=role,
                message=body.message,
                context=context,
                trace_metadata=trace_metadata,
            ):
                yield chunk

        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.exception("[chat/stream] unhandled error: %s", exc)
            yield format_sse({"type": "error", "message": str(exc)})

        finally:
            yield format_sse_done()

    return StreamingResponse(generate(), headers=SSE_HEADERS)


@router.get("/{thread_id}/history")
async def get_history(
    thread_id: str,
    limit: int = 20,
    session: SessionData = Depends(get_session),
    checkpointer: "AsyncPostgresSaver" = Depends(get_checkpointer),
) -> dict:
    """Return conversation history from LangGraph checkpoint.

    The thread_id must belong to the authenticated user to prevent data leakage.
    Accepts both the backend-internal format ({user_id}:{role}) and the PHP
    client conversationId format ({wp_user_id}:{product}:standard), translating
    the latter to the real internal thread_id via the session's user_id.
    """
    # PHP client sends "{wp_user_id}:{product}:standard" — translate to internal format.
    parts = thread_id.split(":")
    if len(parts) == 3 and parts[2] == "standard":
        thread_id = f"{session.user_id}:{parts[1]}"

    if not thread_id.startswith(session.user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "forbidden", "message": "thread_id does not belong to this session"},
        )

    limit = min(limit, 100)

    config = {"configurable": {"thread_id": thread_id}}
    checkpoint_tuple = await checkpointer.aget_tuple(config)  # type: ignore[arg-type]

    if checkpoint_tuple is None:
        return {"threadId": thread_id, "messages": []}

    messages = checkpoint_tuple.checkpoint.get("channel_values", {}).get("messages", [])
    recent = messages[-limit:]
    result = []
    for msg in recent:
        msg_type = msg.__class__.__name__
        content = msg.content if isinstance(msg.content, str) else str(msg.content)
        result.append(
            {
                "role": (
                    "user"
                    if msg_type == "HumanMessage"
                    else "assistant"
                    if msg_type in ("AIMessage", "AIMessageChunk")
                    else "tool"
                ),
                "content": content,
            }
        )

    return {"threadId": thread_id, "messages": result}
