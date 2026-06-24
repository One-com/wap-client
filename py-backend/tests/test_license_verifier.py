"""
Unit tests for LicenseVerifier — base HTTP helper and factory.

Product-specific _verify() implementations (WP Rocket, RankMath) are dummy
stubs and not tested here.  We test the shared infrastructure:
_post_and_parse() error handling and LicenseVerifierFactory.

DEV_BYPASS_LICENSE is intentionally NOT tested here — the bypass is handled
in auth.py (before calling the verifier) so the verifier has no bypass logic.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.config import Settings
from app.services.license_verifier import (
    LicenseVerifierFactory,
    WpRocketLicenseVerifier,
)

_WP_ROCKET_URL = "https://wp-rocket.me/api/v1/validate"


def _make_settings(bypass: bool = False) -> Settings:
    return Settings(
        DATABASE_URL="postgresql+asyncpg://x:x@localhost/x",
        REDIS_URL="redis://localhost",
        SESSION_ENCRYPTION_KEY="dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTEyMzQ=",
        ADMIN_API_KEY="test-admin-key",
        ANTHROPIC_API_KEY="sk-ant-test",
        DEV_BYPASS_LICENSE=bypass,
    )


# ── _post_and_parse HTTP responses ────────────────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_post_and_parse_success():
    respx.post(_WP_ROCKET_URL).mock(return_value=httpx.Response(200, json={"valid": True, "user_id": "u-abc123"}))
    verifier = WpRocketLicenseVerifier(_make_settings(bypass=False))
    result = await verifier._post_and_parse(_WP_ROCKET_URL, {"license_key": "k", "site_url": "https://ex.com"})
    assert result.valid is True
    assert result.user_id == "u-abc123"


@pytest.mark.asyncio
@respx.mock
async def test_post_and_parse_http_4xx_returns_invalid():
    respx.post(_WP_ROCKET_URL).mock(return_value=httpx.Response(403, text="Forbidden"))
    verifier = WpRocketLicenseVerifier(_make_settings(bypass=False))
    result = await verifier._post_and_parse(_WP_ROCKET_URL, {})
    assert result.valid is False
    assert result.user_id == ""


@pytest.mark.asyncio
@respx.mock
async def test_post_and_parse_http_5xx_returns_invalid():
    respx.post(_WP_ROCKET_URL).mock(return_value=httpx.Response(500, text="Internal Server Error"))
    verifier = WpRocketLicenseVerifier(_make_settings(bypass=False))
    result = await verifier._post_and_parse(_WP_ROCKET_URL, {})
    assert result.valid is False


@pytest.mark.asyncio
@respx.mock
async def test_post_and_parse_timeout_returns_invalid():
    respx.post(_WP_ROCKET_URL).mock(side_effect=httpx.TimeoutException("timed out"))
    verifier = WpRocketLicenseVerifier(_make_settings(bypass=False))
    result = await verifier._post_and_parse(_WP_ROCKET_URL, {})
    assert result.valid is False
    assert result.user_id == ""


@pytest.mark.asyncio
@respx.mock
async def test_post_and_parse_valid_false_in_response_json():
    respx.post(_WP_ROCKET_URL).mock(return_value=httpx.Response(200, json={"valid": False, "user_id": ""}))
    verifier = WpRocketLicenseVerifier(_make_settings(bypass=False))
    result = await verifier._post_and_parse(_WP_ROCKET_URL, {})
    assert result.valid is False


# ── LicenseVerifierFactory ────────────────────────────────────────────────────


def test_factory_get_known_products():
    factory = LicenseVerifierFactory(_make_settings())
    assert factory.get("wp-rocket") is not None
    assert factory.get("rankmath") is not None


def test_factory_get_unknown_product_returns_none():
    factory = LicenseVerifierFactory(_make_settings())
    assert factory.get("unknown-product") is None


@pytest.mark.asyncio
async def test_factory_verify_unknown_product_raises_value_error():
    factory = LicenseVerifierFactory(_make_settings())
    with pytest.raises(ValueError, match="Unknown product"):
        await factory.verify("unknown-slug", "key", "https://example.com")
