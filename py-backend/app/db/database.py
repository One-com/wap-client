"""Async SQLAlchemy engine + session factory."""

import ssl
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings


def _ssl_arg_for_sslmode(sslmode: str) -> object | None:
    """Translate a libpq `sslmode` into asyncpg's `ssl` connect arg.

    asyncpg does not parse `?sslmode=` (psycopg does, so config.pg_dsn keeps it).
    Crucially, asyncpg's `ssl=True` means encrypt AND verify the server cert
    against the system CA bundle — stricter than libpq, where only verify-ca /
    verify-full verify. Map each mode to matching semantics so `require` (the
    common case for managed Postgres with a private/self-signed CA) encrypts
    WITHOUT certificate verification.

    Returns the value for connect_args["ssl"], or None to leave SSL unset.
    """
    if sslmode in ("disable", "allow"):
        return None
    if sslmode in ("prefer", "require"):
        # Encrypt, but do not verify the certificate (libpq `require` semantics).
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    if sslmode == "verify-ca":
        # Verify the cert chain but not the hostname.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        return ctx
    if sslmode == "verify-full":
        # Verify chain and hostname (asyncpg's ssl=True default).
        return True
    # Unknown value: fall back to default verifying behaviour.
    return True


def _prepare_asyncpg_url(database_url: str) -> tuple[str, dict[str, object]]:
    """Normalize DATABASE_URL for the asyncpg driver.

    - Rewrites the postgresql:// / postgres:// scheme to postgresql+asyncpg://.
    - Strips the libpq `?sslmode=` query param (asyncpg can't parse it) and
      translates it into the matching asyncpg `ssl` connect arg.

    Returns the cleaned URL and the connect_args to pass to create_async_engine.
    """
    url = database_url
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1).replace(
            "postgres://", "postgresql+asyncpg://", 1
        )

    connect_args: dict[str, object] = {}
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    sslmode = query.pop("sslmode", [None])[0]
    if sslmode is not None:
        ssl_arg = _ssl_arg_for_sslmode(sslmode)
        if ssl_arg is not None:
            connect_args["ssl"] = ssl_arg
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment))

    return url, connect_args


def create_engine(settings: Settings) -> AsyncEngine:
    url, connect_args = _prepare_asyncpg_url(settings.DATABASE_URL)
    # Explicit pool sizing: 5 min + 5 overflow = 10 max connections.
    # Matches the psycopg_pool max_size=10 so the two pools together stay
    # well within Postgres's default max_connections=100.
    return create_async_engine(
        url,
        echo=False,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        connect_args=connect_args,
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
