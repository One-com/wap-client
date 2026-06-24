"""
Redis sliding-window rate limiter.

Uses a sorted set (ZSET) keyed by userId.  Each request is a member scored
by its timestamp.  Members outside the window are removed on each check.
Matches Node.js RateLimiter.ts exactly.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

DEFAULT_WINDOW_MS = 60_000  # 1 minute
DEFAULT_MAX_REQUESTS = 30


@dataclass
class RateLimitResult:
    allowed: bool
    remaining: int
    reset_at: int  # Unix ms


class RateLimiter:
    def __init__(
        self,
        redis: Redis,
        window_ms: int = DEFAULT_WINDOW_MS,
        max_requests: int = DEFAULT_MAX_REQUESTS,
    ) -> None:
        self._redis = redis
        self._window_ms = window_ms
        self._max_requests = max_requests

    async def check(self, key: str) -> RateLimitResult:
        now_ms = int(time.time() * 1000)
        window_start = now_ms - self._window_ms
        redis_key = f"ratelimit:{key}"

        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(redis_key, "-inf", window_start)
            pipe.zadd(redis_key, {f"{now_ms}-{secrets.token_hex(4)}": now_ms})
            pipe.zcard(redis_key)
            pipe.pexpire(redis_key, self._window_ms)
            results = await pipe.execute()

        count: int = results[2] or 0
        return RateLimitResult(
            allowed=count <= self._max_requests,
            remaining=max(0, self._max_requests - count),
            reset_at=now_ms + self._window_ms,
        )
