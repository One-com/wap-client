"""
Auth routes — session creation and revocation.

POST /auth/session
  1. Validate product license (or bypass in dev)
  2. Validate WP App Password + derive stable user_id from WP REST API
  3. Upsert encrypted credentials in site_credentials
  4. Issue session token (agent resolved at chat time, not stored here)

DELETE /auth/session
  Revoke the current session token.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
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
from app.middleware.session_auth import get_session
from app.services.agent_registry import AgentRegistry
from app.services.license_verifier import LicenseVerifierFactory
from app.services.session_bootstrap import create_session_for
from app.services.session_service import SessionData, SessionService
from app.services.site_allowlist_service import SiteAllowlistService

_bearer = HTTPBearer(auto_error=False)

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Request / response schemas ────────────────────────────────────────────────


class AuthBody(BaseModel):
    product: str = Field(min_length=1)
    license_key: str = Field(default="")
    site_url: str = Field(min_length=1)
    mode: str = Field(default="product", pattern="^(product|orchestrator)$")
    mcp_endpoint: str = Field(min_length=1)
    wp_username: str = Field(min_length=1)
    wp_app_password: str = Field(min_length=1)
    available_products: list[str] | None = None


# ── POST /auth/session ────────────────────────────────────────────────────────


@router.post("/session", status_code=200)
async def create_session(  # pylint: disable=too-many-arguments,too-many-positional-arguments
    body: AuthBody,
    settings: Settings = Depends(get_settings),
    license_verifier: LicenseVerifierFactory = Depends(get_license_verifier),
    session_service: SessionService = Depends(get_session_service),
    agent_registry: AgentRegistry = Depends(get_agent_registry),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_session_factory),
    site_allowlist_service: SiteAllowlistService = Depends(get_site_allowlist_service),
) -> dict:
    # The site allowlist gate is always enforced for this public route so a
    # public test env stays confined to allowlisted sites. The deploy-wide
    # DEV_BYPASS_LICENSE flag is applied inside create_session_for itself.
    return await create_session_for(
        product=body.product,
        license_key=body.license_key,
        site_url=body.site_url,
        mode=body.mode,
        mcp_endpoint=body.mcp_endpoint,
        wp_username=body.wp_username,
        wp_app_password=body.wp_app_password,
        available_products=body.available_products,
        skip_license_check=False,
        skip_wp_check=False,
        enforce_allowlist=True,
        settings=settings,
        license_verifier=license_verifier,
        session_service=session_service,
        agent_registry=agent_registry,
        session_factory=session_factory,
        site_allowlist_service=site_allowlist_service,
    )


# ── DELETE /auth/session ──────────────────────────────────────────────────────


@router.delete("/session", status_code=204)
async def revoke_session(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _session: SessionData = Depends(get_session),
    session_service: SessionService = Depends(get_session_service),
) -> None:
    if credentials:
        await session_service.revoke(credentials.credentials)
