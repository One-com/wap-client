"""
In-process agent definition cache.

Loads all agents and role mappings from Postgres at startup.
Resolves {{snippet:key}} placeholders in system prompts at load time.
Admin endpoints call reload() to refresh specific entries.

Cross-pod cache invalidation: after each reload the registry publishes a
JSON message to the Redis channel ``agent_cache_invalidation``.  Every pod
subscribes at startup (see app/main.py) and applies the same reload locally.
Publishing is skipped when ``redis_client`` is None (unit-test mode).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Agent, AgentRoleMap, PromptSnippet

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from app.services.session_service import SessionData

logger = logging.getLogger(__name__)

_PUBSUB_CHANNEL = "agent_cache_invalidation"

# Pattern for snippet placeholders in system prompts
_SNIPPET_RE = re.compile(r"\{\{snippet:([^}]+)\}\}")


@dataclass
class AgentDefinition:  # pylint: disable=too-many-instance-attributes
    """Resolved agent definition — ready to use, snippets already interpolated."""

    id: str
    slug: str
    name: str
    product_slug: str
    provider: str
    model: str
    system_prompt: str  # snippets resolved
    temperature: float
    max_turns: int
    tools: list[dict] | None  # tool descriptor array from DB

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "productSlug": self.product_slug,
            "provider": self.provider,
            "model": self.model,
            "systemPrompt": self.system_prompt,
            "temperature": self.temperature,
            "maxTurns": self.max_turns,
            "tools": self.tools,
        }


def _resolve_snippets(prompt: str, snippets: dict[str, str], agent_slug: str) -> str:
    """Replace {{snippet:key}} placeholders.  Missing keys raise ValueError (fail loudly)."""

    def replace(m: re.Match) -> str:
        key = m.group(1).strip()
        if key not in snippets:
            raise ValueError(
                f"[AgentRegistry] agent '{agent_slug}' references missing snippet '{{{{snippet:{key}}}}}'."
                " Add the snippet to prompt_snippets or fix the agent system_prompt."
            )
        return snippets[key]

    return _SNIPPET_RE.sub(replace, prompt)


def _row_to_def(row: Agent, snippets: dict[str, str]) -> AgentDefinition:
    resolved_prompt = _resolve_snippets(row.system_prompt, snippets, row.slug)
    return AgentDefinition(
        id=str(row.id),
        slug=row.slug,
        name=row.name,
        product_slug=row.product_slug,
        provider=row.provider,
        model=row.model,
        system_prompt=resolved_prompt,
        temperature=row.temperature,
        max_turns=row.max_turns,
        tools=row.tools,
    )


class AgentRegistry:
    """Thread-safe in-process cache of AgentDefinitions.

    Cache is keyed by agent_id (UUID string).
    Role → agent mapping is kept in a separate dict, loaded from agent_role_map.

    When ``redis_client`` is provided, each admin-triggered reload also
    publishes an invalidation message so other pods update their own caches.
    The receiving pod must call ``handle_invalidation_message()`` with the
    raw JSON payload — it does NOT re-publish (no echo loop).
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        redis_client: "Redis | None" = None,
        pubsub_staleness_threshold_s: int = 30,
    ) -> None:
        self._session_factory = session_factory
        self._redis = redis_client
        self._pubsub_staleness_threshold_s = pubsub_staleness_threshold_s
        # agent_id → AgentDefinition
        self._cache: dict[str, AgentDefinition] = {}
        # role → agent_id
        self._role_map: dict[str, str] = {}
        # Set by the subscriber task in main.py; checked by pubsub_healthy.
        self._subscriber_task: asyncio.Task | None = None
        self._last_pubsub_heartbeat: float = 0.0

    async def load(self) -> None:
        """Load all agents, snippets, and role mappings from DB.

        Called once at startup.  Agent definitions with missing snippets raise
        ValueError — the app won't start with a broken prompt.
        """
        async with self._session_factory() as session:
            snippets = await self._load_snippets(session)
            agents = (await session.execute(select(Agent))).scalars().all()
            role_rows = (await session.execute(select(AgentRoleMap))).scalars().all()

        cache: dict[str, AgentDefinition] = {}
        errors: list[str] = []
        for row in agents:
            try:
                cache[str(row.id)] = _row_to_def(row, snippets)
            except ValueError as exc:
                errors.append(str(exc))

        if errors:
            for err in errors:
                logger.error(err)
            raise ValueError(
                f"[AgentRegistry] {len(errors)} agent(s) failed to load due to missing snippets."
                " Fix prompt_snippets table before starting the app."
            )

        self._cache = cache
        self._role_map = {row.role: str(row.agent_id) for row in role_rows}
        logger.info(
            "[AgentRegistry] loaded %d agents, %d role mappings",
            len(self._cache),
            len(self._role_map),
        )

    # ── Lookup methods ────────────────────────────────────────────────────────

    def get_by_id(self, agent_id: str) -> AgentDefinition | None:
        return self._cache.get(agent_id)

    def get_by_role(self, role: str) -> AgentDefinition | None:
        """Look up the active agent for a role (e.g. 'wp-rocket:standard')."""
        agent_id = self._role_map.get(role)
        if agent_id is None:
            return None
        return self._cache.get(agent_id)

    def get_by_product(self, product: str) -> AgentDefinition | None:
        """Convenience: look up the standard agent for a product slug."""
        return self.get_by_role(f"{product}:standard")

    def get_summarizer(self) -> AgentDefinition | None:
        return self.get_by_role("global:summarizer")

    def role_for_session(self, session: "SessionData", *, page_context: str | None = None) -> str:
        """Return the agent role to use for a given session.

        Orchestrator mode always routes to the global orchestrator role.
        When page_context is provided, tries {product}:{page_context} first and
        falls back to {product}:standard if that role is not registered.
        """
        if session.mode == "orchestrator":
            return "global:orchestrator"
        if page_context:
            candidate = f"{session.product}:{page_context}"
            if self._role_map.get(candidate) is not None:
                return candidate
        return f"{session.product}:standard"

    def all(self) -> list[AgentDefinition]:
        return list(self._cache.values())

    def all_roles(self) -> list[dict[str, str]]:
        return [{"role": role, "agentId": agent_id} for role, agent_id in self._role_map.items()]

    # ── Pub/sub health ────────────────────────────────────────────────────────

    @property
    def pubsub_healthy(self) -> bool:
        """True when pub/sub is not configured (no Redis) or is actively running.

        Returns False when Redis is configured but the subscriber task has died
        or gone silent for longer than ``pubsub_staleness_threshold_s`` seconds.
        Used by the /health readiness probe.
        """
        if self._redis is None:
            return True
        if self._subscriber_task is None or self._subscriber_task.done():
            return False
        if self._last_pubsub_heartbeat == 0.0:
            return True  # task started but hasn't had a first tick yet
        return (time.monotonic() - self._last_pubsub_heartbeat) <= self._pubsub_staleness_threshold_s

    def record_pubsub_heartbeat(self) -> None:
        """Called by the subscriber loop on every get_message() iteration."""
        self._last_pubsub_heartbeat = time.monotonic()

    # ── Mutation (triggered by admin endpoints) ────────────────────────────────

    async def reload(self, agent_id: str) -> None:
        """Reload a single agent from DB (after admin PUT /agents/:id)."""
        async with self._session_factory() as session:
            snippets = await self._load_snippets(session)
            result = await session.execute(select(Agent).where(Agent.id == uuid.UUID(agent_id)))
            row = result.scalar_one_or_none()
        if row:
            self._cache[agent_id] = _row_to_def(row, snippets)
        await self._publish({"action": "reload_agent", "agent_id": agent_id})

    async def reload_role(self, role: str) -> None:
        """Reload the role mapping for a single role (after admin PUT /roles/:role)."""
        async with self._session_factory() as session:
            result = await session.execute(select(AgentRoleMap).where(AgentRoleMap.role == role))
            row = result.scalar_one_or_none()
        if row:
            self._role_map[role] = str(row.agent_id)
        else:
            self._role_map.pop(role, None)
        await self._publish({"action": "reload_role", "role": role})

    async def reload_snippets_for_agents(self, key: str) -> None:
        """Re-resolve snippets for all agents that reference the given snippet key."""
        async with self._session_factory() as session:
            snippets = await self._load_snippets(session)
            agents = (await session.execute(select(Agent))).scalars().all()
        for row in agents:
            if f"{{{{snippet:{key}}}}}" in row.system_prompt:
                try:
                    self._cache[str(row.id)] = _row_to_def(row, snippets)
                except ValueError as exc:
                    logger.error("[AgentRegistry] reload_snippets_for_agents: %s", exc)
        await self._publish({"action": "reload_snippets", "snippet_key": key})

    def invalidate(self, agent_id: str) -> None:
        self._cache.pop(agent_id, None)

    async def handle_invalidation_message(self, payload: str) -> None:
        """Apply a cache invalidation message received from another pod via pub/sub.

        Does NOT re-publish — callers must only call this from the subscriber loop.
        """
        try:
            msg = json.loads(payload)
        except json.JSONDecodeError:
            logger.warning("[AgentRegistry] ignoring unparseable pub/sub message: %.200s", payload)
            return

        action = msg.get("action")
        if action == "reload_agent":
            await self._pubsub_reload_agent(msg.get("agent_id", ""))
        elif action == "reload_role":
            await self._pubsub_reload_role(msg.get("role", ""))
        elif action == "reload_snippets":
            await self._pubsub_reload_snippets(msg.get("snippet_key", ""))
        elif action == "reload_all":
            await self.load()
            logger.info("[AgentRegistry] pub/sub: full reload")
        else:
            logger.warning("[AgentRegistry] pub/sub: unknown action %r — ignored", action)

    async def _pubsub_reload_agent(self, agent_id: str) -> None:
        async with self._session_factory() as session:
            snippets = await self._load_snippets(session)
            result = await session.execute(select(Agent).where(Agent.id == uuid.UUID(agent_id)))
            row: Agent | None = result.scalar_one_or_none()
        if row:
            self._cache[agent_id] = _row_to_def(row, snippets)
            logger.info("[AgentRegistry] pub/sub: reloaded agent %s", agent_id)

    async def _pubsub_reload_role(self, role: str) -> None:
        async with self._session_factory() as session:
            result = await session.execute(select(AgentRoleMap).where(AgentRoleMap.role == role))
            row: AgentRoleMap | None = result.scalar_one_or_none()
        if row:
            self._role_map[role] = str(row.agent_id)
        else:
            self._role_map.pop(role, None)
        logger.info("[AgentRegistry] pub/sub: reloaded role %s", role)

    async def _pubsub_reload_snippets(self, key: str) -> None:
        async with self._session_factory() as session:
            snippets = await self._load_snippets(session)
            agents = (await session.execute(select(Agent))).scalars().all()
        for row in agents:
            if f"{{{{snippet:{key}}}}}" in row.system_prompt:
                try:
                    self._cache[str(row.id)] = _row_to_def(row, snippets)
                except ValueError as exc:
                    logger.error("[AgentRegistry] pub/sub reload_snippets: %s", exc)
        logger.info("[AgentRegistry] pub/sub: reloaded snippet %s", key)

    # ── Private helpers ───────────────────────────────────────────────────────

    async def _publish(self, payload: dict) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.publish(_PUBSUB_CHANNEL, json.dumps(payload))
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning("[AgentRegistry] pub/sub publish failed: %s", exc)

    @staticmethod
    async def _load_snippets(session: AsyncSession) -> dict[str, str]:
        rows = (await session.execute(select(PromptSnippet))).scalars().all()
        return {row.key: row.content for row in rows}
