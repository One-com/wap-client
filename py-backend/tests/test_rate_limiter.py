"""
Unit tests for RateLimiter — Redis ZSET sliding-window semantics.

Uses a small in-memory fake that mimics the subset of the Redis pipeline API the
limiter relies on (zremrangebyscore / zadd / zcard / pexpire), so the sliding-window
logic is exercised without a real Redis.
"""

import pytest

from app.services.rate_limiter import RateLimiter


class _FakePipeline:
    """Mimics redis.asyncio pipeline(transaction=True) for ZSET ops on one store."""

    def __init__(self, store: dict[str, dict[str, int]]) -> None:
        self._store = store
        self._ops: list = []

    async def __aenter__(self) -> "_FakePipeline":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def zremrangebyscore(self, key: str, lo: str, hi: int) -> None:
        self._ops.append(("zrem", key, hi))

    def zadd(self, key: str, mapping: dict[str, int]) -> None:
        self._ops.append(("zadd", key, mapping))

    def zcard(self, key: str) -> None:
        self._ops.append(("zcard", key, None))

    def pexpire(self, key: str, ttl: int) -> None:
        self._ops.append(("pexpire", key, ttl))

    async def execute(self) -> list:
        results: list = []
        for op, key, arg in self._ops:
            members = self._store.setdefault(key, {})
            if op == "zrem":
                # Remove members scored <= window_start (arg)
                for m in [m for m, score in members.items() if score <= arg]:
                    del members[m]
                results.append(None)
            elif op == "zadd":
                members.update(arg)
                results.append(len(arg))
            elif op == "zcard":
                results.append(len(members))
            elif op == "pexpire":
                results.append(True)
        self._ops = []
        return results


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, dict[str, int]] = {}

    def pipeline(self, transaction: bool = True) -> _FakePipeline:  # noqa: ARG002
        return _FakePipeline(self.store)


@pytest.mark.asyncio
async def test_allows_under_limit():
    limiter = RateLimiter(_FakeRedis(), window_ms=60_000, max_requests=3)
    for _ in range(3):
        result = await limiter.check("user1")
        assert result.allowed is True
    assert result.remaining == 0


@pytest.mark.asyncio
async def test_blocks_when_exceeding_limit():
    limiter = RateLimiter(_FakeRedis(), window_ms=60_000, max_requests=3)
    # 4th request within the window must be blocked
    for _ in range(3):
        await limiter.check("user1")
    result = await limiter.check("user1")
    assert result.allowed is False
    assert result.remaining == 0
    assert result.reset_at > 0


@pytest.mark.asyncio
async def test_per_user_isolation():
    limiter = RateLimiter(_FakeRedis(), window_ms=60_000, max_requests=1)
    a = await limiter.check("userA")
    b = await limiter.check("userB")
    # Each user has its own window — neither blocks the other on the first call
    assert a.allowed is True
    assert b.allowed is True


@pytest.mark.asyncio
async def test_old_entries_fall_out_of_window(monkeypatch):
    """Entries older than the window are pruned so they don't count toward the limit."""
    import app.services.rate_limiter as rl_mod

    redis = _FakeRedis()
    limiter = RateLimiter(redis, window_ms=1_000, max_requests=1)

    # First request at t=0
    monkeypatch.setattr(rl_mod.time, "time", lambda: 0.0)
    first = await limiter.check("user1")
    assert first.allowed is True

    # Second request well past the window — the old entry is pruned, so this is allowed
    monkeypatch.setattr(rl_mod.time, "time", lambda: 100.0)
    second = await limiter.check("user1")
    assert second.allowed is True


@pytest.mark.asyncio
async def test_default_limit_matches_spec():
    """WPIN-8554: default is 30 requests / 60s per user_id."""
    assert rl_defaults() == (60_000, 30)


def rl_defaults():
    from app.services.rate_limiter import DEFAULT_MAX_REQUESTS, DEFAULT_WINDOW_MS

    return DEFAULT_WINDOW_MS, DEFAULT_MAX_REQUESTS
