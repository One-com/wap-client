"""
Redis pub/sub subscriber for cross-pod agent cache invalidation.

One long-running asyncio task per pod.  When an admin saves changes via the
admin API, the pod handling the request publishes a small JSON message.  This
task receives it and applies the same reload locally so all pods stay in sync.

Reconnects automatically with exponential back-off after a Redis disconnect.
On reconnect it performs a full ``registry.load()`` to avoid any window of
staleness that occurred while the subscription was down.
"""

from __future__ import annotations

import asyncio
import logging

from redis.asyncio import Redis

from app.services.agent_registry import _PUBSUB_CHANNEL, AgentRegistry

logger = logging.getLogger(__name__)

_INITIAL_BACKOFF_S = 1.0
_MAX_BACKOFF_S = 60.0
_GET_MESSAGE_TIMEOUT_S = 1.0


async def run_cache_invalidation_subscriber(redis: Redis, registry: AgentRegistry) -> None:
    """Long-running task: subscribe and dispatch cache invalidation messages.

    Designed to run for the lifetime of the process.  Cancellation (on
    shutdown) is handled cleanly.
    """
    backoff = _INITIAL_BACKOFF_S
    while True:
        try:
            await _subscribe_loop(redis, registry)
            backoff = _INITIAL_BACKOFF_S  # reset on clean exit (shouldn't happen)
        except asyncio.CancelledError:
            logger.info("[AgentPubSub] subscriber cancelled — shutting down")
            return
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning(
                "[AgentPubSub] subscriber disconnected (%s) — reconnecting in %.0fs",
                exc,
                backoff,
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF_S)
            # Full reload to cover any messages missed during the outage.
            try:
                await registry.load()
                logger.info("[AgentPubSub] full reload after reconnect")
            except Exception as reload_exc:  # pylint: disable=broad-exception-caught
                logger.error("[AgentPubSub] full reload failed: %s", reload_exc)


async def _subscribe_loop(redis: Redis, registry: AgentRegistry) -> None:
    pubsub = redis.pubsub()
    try:
        await pubsub.subscribe(_PUBSUB_CHANNEL)
        logger.info("[AgentPubSub] subscribed to %s", _PUBSUB_CHANNEL)
        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=_GET_MESSAGE_TIMEOUT_S,
            )
            registry.record_pubsub_heartbeat()
            if message is not None and message.get("type") == "message":
                data = message.get("data", "")
                await registry.handle_invalidation_message(data)
    finally:
        await pubsub.unsubscribe(_PUBSUB_CHANNEL)
        await pubsub.aclose()
