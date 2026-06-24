"""
Site allowlist — gates session creation by matching site_url against
admin-managed patterns (fnmatch wildcards).

Only consulted when settings.AUTH_SITE_ALLOWLIST_ENABLED is true. Fails closed:
when enabled with an empty table, no site is allowed.
"""

from __future__ import annotations

import fnmatch
import uuid
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import SiteAllowlist


def _normalize(site_url: str) -> str:
    """Reduce a URL to scheme://netloc (lowercased), dropping any path/query.

    Mirrors the urlparse approach in wp_connection_service. Patterns are matched
    against this normalized form so a trailing slash or path can't bypass/break
    matching.
    """
    parsed = urlparse(site_url.strip())
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}".lower()
    # Fall back to the raw (stripped, lowercased) value if it isn't a full URL.
    return site_url.strip().rstrip("/").lower()


def _match(pattern: str, site_url: str) -> bool:
    """True if site_url matches the (possibly wildcarded) pattern."""
    return fnmatch.fnmatch(_normalize(site_url), pattern.strip().lower())


class SiteAllowlistService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def list_all(self) -> list[SiteAllowlist]:
        async with self._session_factory() as session:
            rows = (await session.execute(select(SiteAllowlist).order_by(SiteAllowlist.pattern))).scalars().all()
        return list(rows)

    async def add(self, pattern: str, description: str | None = None) -> SiteAllowlist:
        async with self._session_factory() as session:
            async with session.begin():
                entry = SiteAllowlist(pattern=pattern.strip(), description=description)
                session.add(entry)
            await session.refresh(entry)
        return entry

    async def delete(self, entry_id: uuid.UUID) -> None:
        async with self._session_factory() as session:
            async with session.begin():
                entry = await session.get(SiteAllowlist, entry_id)
                if entry is not None:
                    await session.delete(entry)

    async def is_allowed(self, site_url: str) -> bool:
        """True if site_url matches any allowlist pattern.

        Fails closed: an empty allowlist allows nothing (the caller only invokes
        this when the feature is enabled, so an empty table is a misconfiguration,
        not 'allow all').
        """
        entries = await self.list_all()
        return any(_match(e.pattern, site_url) for e in entries)
