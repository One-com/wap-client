"""
Admin chat-tester auth route.

``POST /admin/chat/session`` lets an authenticated admin mint a normal session
token from the admin UI, so the reused WP chat widget can talk to the real
``/api/v1/chat/stream`` and ``/api/v1/chat/{id}/history`` endpoints — making the
admin tester as representative as a real WordPress client.

It goes through the same :func:`create_session_for` helper as the public
``/api/v1/auth/session`` route. The only admin-specific behaviour:

  - Access is gated by the admin API key or admin session cookie (``_require_admin``),
    not a WordPress license.
  - When the admin leaves the WP connection fields empty, validation is bypassed
    *per request* (not via the deploy-wide ``DEV_BYPASS_LICENSE`` flag) so an admin
    can chat with an agent without provisioning real WP credentials. When the
    fields are filled in, the full license + WP App Password validation runs,
    exactly like production.
"""

# The create_session_for(...) call below necessarily mirrors the one in
# app/routes/auth.py — both routes feed the same shared helper the same kwargs.
# That intentional similarity is not copy-paste to deduplicate.
# pylint: disable=duplicate-code
from __future__ import annotations

import logging
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.dependencies import (
    get_agent_registry,
    get_license_verifier,
    get_session_factory,
    get_session_service,
    get_settings,
    get_site_allowlist_service,
)
from app.routes.admin import _require_admin
from app.services.agent_registry import AgentRegistry
from app.services.license_verifier import LicenseVerifierFactory
from app.services.session_bootstrap import create_session_for
from app.services.session_service import SessionService
from app.services.site_allowlist_service import SiteAllowlistService

logger = logging.getLogger(__name__)
router = APIRouter()

# Synthetic site_url used when the admin chats without a real WordPress site.
_ADMIN_SITE_URL = "admin://local"


class AdminChatAuthBody(BaseModel):
    """Like AuthBody, but every WP connection field is optional.

    Leaving mcp_endpoint / wp_username / wp_app_password empty triggers the
    per-request validation bypass (admin testing without a real WP site).
    """

    product: str = Field(min_length=1)
    mode: str = Field(default="product", pattern="^(product|orchestrator)$")
    mcp_endpoint: str = Field(default="")
    wp_username: str = Field(default="")
    wp_app_password: str = Field(default="")
    license_key: str = Field(default="")
    available_products: list[str] | None = None


@router.post("/chat/session", status_code=200, dependencies=[Depends(_require_admin)])
async def admin_chat_session(  # pylint: disable=too-many-arguments,too-many-positional-arguments
    body: AdminChatAuthBody,
    _request: Request,
    settings: Settings = Depends(get_settings),
    license_verifier: LicenseVerifierFactory = Depends(get_license_verifier),
    session_service: SessionService = Depends(get_session_service),
    agent_registry: AgentRegistry = Depends(get_agent_registry),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_session_factory),
    site_allowlist_service: SiteAllowlistService = Depends(get_site_allowlist_service),
) -> dict:
    wp_fields_present = bool(body.mcp_endpoint and body.wp_username and body.wp_app_password)
    if wp_fields_present:
        _p = urlparse(body.mcp_endpoint)
        site_url = f"{_p.scheme}://{_p.netloc}"
    else:
        site_url = _ADMIN_SITE_URL

    if not wp_fields_present:
        logger.info("[admin/chat/session] minting bypass session (no WP credentials) for product=%s", body.product)

    return await create_session_for(
        product=body.product,
        license_key=body.license_key,
        site_url=site_url,
        mode=body.mode,
        mcp_endpoint=body.mcp_endpoint,
        wp_username=body.wp_username,
        wp_app_password=body.wp_app_password,
        available_products=body.available_products,
        # The admin route never validates a license — the request is already gated
        # by _require_admin and admin testing doesn't involve real license keys.
        skip_license_check=True,
        # WP credential check runs when fields are supplied; bypassed when empty.
        skip_wp_check=not wp_fields_present,
        # Don't subject the admin tester to the public site allowlist (the synthetic
        # site_url would never be allowlisted anyway).
        enforce_allowlist=False,
        settings=settings,
        license_verifier=license_verifier,
        session_service=session_service,
        agent_registry=agent_registry,
        session_factory=session_factory,
        site_allowlist_service=site_allowlist_service,
    )
