"""
License verification — abstract base + per-product implementations.

BaseLicenseVerifier defines the contract.
Concrete subclasses handle product-specific API differences.
LicenseVerifierFactory returns the right instance by product slug.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 10.0


class LicenseVerificationResult:
    def __init__(self, valid: bool, user_id: str) -> None:
        self.valid = valid
        self.user_id = user_id


class BaseLicenseVerifier(ABC):
    """Abstract base for product-specific license verification."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def verify(self, license_key: str, site_url: str) -> LicenseVerificationResult:
        return await self._verify(license_key, site_url)

    @abstractmethod
    async def _verify(self, license_key: str, site_url: str) -> LicenseVerificationResult:
        """Product-specific verification logic."""

    @property
    @abstractmethod
    def product_slug(self) -> str:
        """The product slug this verifier handles."""

    async def _post_and_parse(self, url: str, payload: dict) -> LicenseVerificationResult:
        """HTTP POST helper shared by simple JSON API verifiers."""
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
            if not resp.is_success:
                return LicenseVerificationResult(valid=False, user_id="")
            data = resp.json()
            return LicenseVerificationResult(
                valid=data.get("valid") is True,
                user_id=data.get("user_id", ""),
            )
        except httpx.TimeoutException:
            logger.error("[%s] timeout verifying license", self.__class__.__name__)
            return LicenseVerificationResult(valid=False, user_id="")
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.error("[%s] error: %s", self.__class__.__name__, exc)
            return LicenseVerificationResult(valid=False, user_id="")


class WpRocketLicenseVerifier(BaseLicenseVerifier):
    @property
    def product_slug(self) -> str:
        return "wp-rocket"

    async def _verify(self, license_key: str, site_url: str) -> LicenseVerificationResult:
        return await self._post_and_parse(
            self._settings.WP_ROCKET_LICENSE_API_URL,
            {"license_key": license_key, "site_url": site_url},
        )


class RankMathLicenseVerifier(BaseLicenseVerifier):
    @property
    def product_slug(self) -> str:
        return "rankmath"

    async def _verify(self, license_key: str, site_url: str) -> LicenseVerificationResult:
        return await self._post_and_parse(
            self._settings.RANKMATH_LICENSE_API_URL,
            {"license_key": license_key, "site_url": site_url},
        )


class LicenseVerifierFactory:
    """Returns the appropriate BaseLicenseVerifier for a given product slug."""

    def __init__(self, settings: Settings) -> None:
        self._verifiers: dict[str, BaseLicenseVerifier] = {
            v.product_slug: v
            for v in [
                WpRocketLicenseVerifier(settings),
                RankMathLicenseVerifier(settings),
            ]
        }

    def get(self, product_slug: str) -> BaseLicenseVerifier | None:
        return self._verifiers.get(product_slug)

    async def verify(self, product_slug: str, license_key: str, site_url: str) -> LicenseVerificationResult:
        verifier = self.get(product_slug)
        if verifier is None:
            raise ValueError(f"Unknown product: {product_slug}")
        return await verifier.verify(license_key, site_url)
