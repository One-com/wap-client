"""
Shared session-bootstrap logic.

Both the public WordPress auth route (``POST /api/v1/auth/session``) and the
admin-only chat tester (``POST /admin/chat/session``) need to perform the exact
same sequence to mint a session: validate (optionally), derive a stable user id,
persist encrypted credentials, resolve the agent, and issue a token.

The single difference between the two callers is *whether validation runs*:

  - The public route ties it to the deploy-wide ``DEV_BYPASS_LICENSE`` flag.
  - The admin route bypasses validation per-request when the admin leaves the WP
    connection fields empty (a convenience confined to authenticated admins).

To keep the admin path from drifting from production, both go through
:func:`create_session_for` with an explicit ``skip_validation`` argument instead
of each re-reading global config. This guarantees byte-identical session creation
regardless of caller.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from datetime import datetime

import httpx
from fastapi import HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.db.models import SiteCredential
from app.lib.encryption import encrypt
from app.services.agent_registry import AgentRegistry
from app.services.license_verifier import LicenseVerifierFactory
from app.services.session_service import SessionData, SessionService
from app.services.site_allowlist_service import SiteAllowlistService

logger = logging.getLogger(__name__)

_WP_USERS_ME_TIMEOUT = 10.0  # seconds


def derive_user_id(site_url: str, wp_user_id: int) -> str:
    """Stable user identifier: SHA-256(site_url + ":" + str(wp_user_id))[:32].

    Stable across password rotations and username changes.
    """
    raw = f"{site_url}:{wp_user_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


async def validate_wp_app_password(
    site_url: str,
    wp_username: str,
    wp_app_password: str,
) -> int:
    """Call GET /wp-json/wp/v2/users/me with Basic auth.

    Returns the WordPress integer user ID on success.
    Raises HTTPException 401 on bad credentials or 502 on network error.
    """
    url = site_url.rstrip("/") + "/wp-json/wp/v2/users/me"
    try:
        async with httpx.AsyncClient(timeout=_WP_USERS_ME_TIMEOUT) as client:
            resp = await client.get(url, auth=(wp_username, wp_app_password))
    except httpx.TimeoutException as exc:
        logger.error("[session_bootstrap] timeout calling /wp-json/wp/v2/users/me at %s", site_url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "wp_timeout", "message": "WordPress site did not respond in time"},
        ) from exc
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.error("[session_bootstrap] error calling WP REST API: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "wp_unreachable", "message": str(exc)},
        ) from exc

    if resp.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "invalid_app_password", "message": "WordPress App Password is invalid or revoked"},
        )
    if not resp.is_success:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "wp_error", "message": f"WordPress returned HTTP {resp.status_code}"},
        )

    data = resp.json()
    wp_user_id: int = data.get("id")
    if not wp_user_id:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "wp_bad_response", "message": "WP /users/me did not return user id"},
        )
    return wp_user_id


async def create_session_for(  # pylint: disable=too-many-arguments,too-many-locals,too-many-positional-arguments,too-many-branches
    *,
    product: str,
    license_key: str,
    site_url: str,
    mode: str,
    mcp_endpoint: str,
    wp_username: str,
    wp_app_password: str,
    available_products: list[str] | None,
    skip_license_check: bool,
    skip_wp_check: bool,
    enforce_allowlist: bool,
    settings: Settings,
    license_verifier: LicenseVerifierFactory,
    session_service: SessionService,
    agent_registry: AgentRegistry,
    session_factory: async_sessionmaker[AsyncSession],
    site_allowlist_service: SiteAllowlistService,
) -> dict:
    """Run the full session-creation sequence and return the auth response dict.

    ``skip_license_check`` and ``skip_wp_check`` gate Steps 1 and 2 independently.
    ``skip_license_check`` is also ORed with the deploy-wide ``DEV_BYPASS_LICENSE``
    flag here, so callers pass ``False`` and let the env var do its job. ``skip_wp_check``
    is never affected by ``DEV_BYPASS_LICENSE`` — it is a credential concern, not a license
    concern. ``enforce_allowlist`` is independent of both.
    """
    skip_license_check = skip_license_check or settings.DEV_BYPASS_LICENSE
    skip_wp_check = skip_wp_check or settings.DEV_BYPASS_WP_CHECK

    # Step 0 — site allowlist gate (test/staging abuse protection).
    if enforce_allowlist and settings.AUTH_SITE_ALLOWLIST_ENABLED:
        if not await site_allowlist_service.is_allowed(site_url):
            logger.warning("[session_bootstrap] site_not_allowed: %s", site_url)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "site_not_allowed", "message": "Site URL not authorized for this environment"},
            )

    # Step 1 — validate license (or bypass)
    if skip_license_check:
        logger.warning("[session_bootstrap] skip_license_check: skipping license validation for %s", site_url)
    else:
        try:
            result = await license_verifier.verify(product, license_key, site_url)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"error": "unknown_product", "message": f"Unknown product: {product}"},
            ) from exc
        if not result.valid:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "license_invalid", "message": "License key validation failed"},
            )

    # Step 2 — validate WP App Password + derive stable user_id (or bypass)
    if skip_wp_check:
        logger.warning("[session_bootstrap] skip_wp_check: skipping WP App Password validation for %s", site_url)
        wp_user_id = 1
    else:
        wp_user_id = await validate_wp_app_password(
            site_url=site_url,
            wp_username=wp_username,
            wp_app_password=wp_app_password,
        )

    user_id = derive_user_id(site_url, wp_user_id)

    # Step 3 — upsert encrypted credentials
    encrypted_password = encrypt(wp_app_password, settings.SESSION_ENCRYPTION_KEY)

    async with session_factory() as db_session:
        async with db_session.begin():
            existing = await db_session.execute(
                select(SiteCredential)
                .where(
                    and_(
                        SiteCredential.user_id == user_id,
                        SiteCredential.site_url == site_url,
                        SiteCredential.product == product,
                    )
                )
                .limit(1)
            )
            cred = existing.scalar_one_or_none()

            if cred:
                cred.encrypted_wp_app_password = encrypted_password
                cred.wp_username = wp_username
                cred.mcp_endpoint = mcp_endpoint
                cred.updated_at = datetime.utcnow()
            else:
                db_session.add(
                    SiteCredential(
                        id=uuid.uuid4(),
                        user_id=user_id,
                        site_url=site_url,
                        product=product,
                        wp_username=wp_username,
                        encrypted_wp_app_password=encrypted_password,
                        mcp_endpoint=mcp_endpoint,
                    )
                )

    # Step 4 — look up agent for this product (for the response only).
    # Agent is NOT stored in the session — resolved at chat time so live swaps work.
    role = f"{product}:standard"
    agent = agent_registry.get_by_role(role)
    if not agent and mode == "product":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "no_agent", "message": f"No active agent for role: {role}"},
        )

    # Step 5 — determine available products list
    resolved_products = available_products if mode == "orchestrator" and available_products else [product]

    # Step 6 — issue session token
    session_data = SessionData(
        user_id=user_id,
        product=product,
        site_url=site_url,
        mcp_endpoint=mcp_endpoint,
        mode=mode,
        available_products=resolved_products,
        created_at=int(time.time() * 1000),
    )
    token = await session_service.create(session_data)

    if skip_license_check or skip_wp_check:
        logger.warning(
            "[session_bootstrap] session created for %s (license bypassed=%s, WP credentials bypassed=%s)",
            site_url,
            skip_license_check,
            skip_wp_check,
        )

    response = {
        "token": token,
        "ttl": 3600,
        "mode": mode,
        "conversationId": f"{user_id}:{product}:standard",
    }
    if agent:
        response["agent"] = {"id": agent.id, "name": agent.name, "model": agent.model}

    return response
