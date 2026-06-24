"""
Admin session management in Redis, separate from end-user sessions.

Key pattern: admin_session:{sha256(token)}
TTL: 28800 seconds (8 hours)
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis

_TTL = 28800  # 8 hours


def _key(token: str) -> str:
    return f"admin_session:{hashlib.sha256(token.encode()).hexdigest()}"


@dataclass
class AdminSessionData:
    admin_user_id: str
    email: str
    display_name: str | None
    created_at: int  # Unix ms timestamp

    def to_dict(self) -> dict[str, Any]:
        return {
            "adminUserId": self.admin_user_id,
            "email": self.email,
            "displayName": self.display_name,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AdminSessionData:
        return cls(
            admin_user_id=d["adminUserId"],
            email=d["email"],
            display_name=d.get("displayName"),
            created_at=d["createdAt"],
        )


class AdminSessionService:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def create(self, data: AdminSessionData) -> str:
        token = secrets.token_hex(32)
        await self._redis.set(_key(token), json.dumps(data.to_dict()), ex=_TTL)
        return token

    async def validate(self, token: str) -> AdminSessionData | None:
        raw = await self._redis.get(_key(token))
        if raw is None:
            return None
        return AdminSessionData.from_dict(json.loads(raw))

    async def revoke(self, token: str) -> None:
        await self._redis.delete(_key(token))
