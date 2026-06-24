"""
User self-service routes.

DELETE /me/data — GDPR right to erasure.
  Deletes all LangGraph checkpoint data for the user, removes site_credentials,
  and revokes the current session.  Returns 204 with no remaining user data.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response
from sqlalchemy import delete

from app.db.models import SiteCredential
from app.middleware.session_auth import get_session
from app.services.session_service import SessionData
from app.state import get_state

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/data/erase", status_code=204)
async def erase_my_data(
    request: Request,
    session: SessionData = Depends(get_session),
) -> Response:
    """Alias of delete_my_data via POST — browsers block DELETE to localhost (Private Network Access)."""
    return await delete_my_data(request, session)


@router.delete("/data", status_code=204)
async def delete_my_data(
    request: Request,
    session: SessionData = Depends(get_session),
) -> Response:
    """GDPR right to erasure.

    Deletes:
      - All LangGraph checkpoints for all threads belonging to this user
      - All site_credentials rows for this user
      - The current session token

    Returns 204 with no body.  No user data remains after this call.
    """
    state = get_state(request)
    session_factory = state.session_factory
    session_service = state.session_service

    auth_header = request.headers.get("Authorization", "")
    token = auth_header.removeprefix("Bearer ").strip()

    await _delete_user_checkpoints(state.pg_pool, session.user_id)

    # Step 2 — delete site_credentials rows
    await _delete_site_credentials(session_factory, session.user_id)

    # Step 3 — revoke current session
    await session_service.revoke(token)

    logger.info("[me/data] GDPR erasure complete for user_id %s", session.user_id[:8] + "...")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _delete_user_checkpoints(pg_pool: Any, user_id: str) -> None:
    """Delete all LangGraph checkpoints whose thread_id starts with the user_id.

    Uses a separate AsyncPostgresSaver instance per operation — alist() holds
    self.lock for the full iteration, so adelete_thread() on the same instance
    would deadlock waiting for the same lock.
    """
    # Deferred: langgraph is an optional heavy dependency; import inside function
    # avoids an ImportError at startup if the package is not installed.
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver  # pylint: disable=import-outside-toplevel

    try:
        thread_ids = []
        async for ct in AsyncPostgresSaver(pg_pool).alist(config=None):
            thread_id = ct.config.get("configurable", {}).get("thread_id", "")
            if thread_id.startswith(f"{user_id}:"):
                thread_ids.append(thread_id)

        for thread_id in thread_ids:
            await AsyncPostgresSaver(pg_pool).adelete_thread(thread_id)
            logger.debug("[me/data] deleted thread %s", thread_id)

        logger.info("[me/data] deleted %d thread(s) for user %s", len(thread_ids), user_id[:8] + "...")
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.error("[me/data] error deleting checkpoints for user %s: %s", user_id[:8], exc)


async def _delete_site_credentials(session_factory: Any, user_id: str) -> None:
    """Delete all site_credentials rows for the user."""
    async with session_factory() as db_session:
        async with db_session.begin():
            await db_session.execute(delete(SiteCredential).where(SiteCredential.user_id == user_id))
