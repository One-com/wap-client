"""
Session token management in Redis.

Token lifecycle:
  - Create:   secrets.token_hex(32) → store JSON under session:{sha256(token)}, TTL 600s
  - Validate: lookup by SHA-256 hash; fixed TTL (no sliding expiry)
  - Revoke:   delete the Redis key

The agent is NOT stored in the session — it is resolved at chat time from the
AgentRegistry so live agent swaps take effect without re-auth.
"""

import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis

SESSION_TTL = 600  # seconds — 10 min; JS re-auths automatically on 401


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _key(token: str) -> str:
    return f"session:{_hash(token)}"


@dataclass
class SessionData:
    user_id: str  # SHA-256(site_url + ":" + str(wp_user_id))[:32]
    product: str  # e.g. "wp-rocket"
    site_url: str
    mcp_endpoint: str
    mode: str  # "product" | "orchestrator"
    available_products: list[str]
    created_at: int  # Unix ms timestamp

    def to_dict(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "product": self.product,
            "siteUrl": self.site_url,
            "mcpEndpoint": self.mcp_endpoint,
            "mode": self.mode,
            "availableProducts": self.available_products,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "SessionData":
        return cls(
            user_id=d["userId"],
            product=d["product"],
            site_url=d["siteUrl"],
            mcp_endpoint=d["mcpEndpoint"],
            mode=d["mode"],
            available_products=d.get("availableProducts", [d["product"]]),
            created_at=d["createdAt"],
        )


class SessionService:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def create(self, data: SessionData) -> str:
        token = secrets.token_hex(32)
        await self._redis.set(_key(token), json.dumps(data.to_dict()), ex=SESSION_TTL)
        return token

    async def validate(self, token: str) -> SessionData | None:
        raw = await self._redis.get(_key(token))
        if raw is None:
            return None
        return SessionData.from_dict(json.loads(raw))

    async def revoke(self, token: str) -> None:
        await self._redis.delete(_key(token))
