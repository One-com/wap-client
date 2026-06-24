"""
Application settings loaded from environment variables + optional .env file.

Priority (highest → lowest):
  1. OS environment variables  ← Docker's `environment:` block always wins
  2. .env file values
  3. Field defaults

This matches Node.js `dotenv.config({ override: true })` semantics.
DEV_BYPASS_LICENSE must NEVER be true in production.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Server
    PORT: int = 8000
    ENV: str = "development"

    # Database (asyncpg scheme required for SQLAlchemy async)
    DATABASE_URL: str

    # Redis
    REDIS_URL: str
    # How many seconds of silence from the pub/sub subscriber loop before the
    # /health readiness probe reports unhealthy and Kubernetes pulls the pod.
    PUBSUB_STALENESS_THRESHOLD_S: int = 30

    # Crypto — base64-encoded 32-byte key
    # Generate: python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
    SESSION_ENCRYPTION_KEY: str

    # Auth
    ADMIN_API_KEY: str

    # Anthropic
    ANTHROPIC_API_KEY: str

    # Conversation summarization — compress history once a thread exceeds this many messages.
    SUMMARIZER_MESSAGE_THRESHOLD: int = 20

    # External product license APIs
    WP_ROCKET_LICENSE_API_URL: str = "https://wp-rocket.me/api/v1/validate"
    RANKMATH_LICENSE_API_URL: str = "https://rankmath.com/api/v1/validate"

    # Dev bypass — set to true ONLY for local development to skip license validation.
    # NEVER use in production.
    DEV_BYPASS_LICENSE: bool = False

    # Skip WP App Password validation (GET /wp-json/wp/v2/users/me).
    # Set to true locally when the WP site is unreachable from inside Docker.
    # NEVER use in production.
    DEV_BYPASS_WP_CHECK: bool = False

    # CORS — comma-separated list of allowed origins for browser requests.
    # Required in production; defaults to "*" in development.
    # Example: "https://client1.wp-rocket.me,https://client2.wp-rocket.me"
    ALLOWED_ORIGINS: str = ""

    # Public API base URL — the externally reachable origin for /api/* endpoints.
    # Set on k8s environments where the admin UI (/admin/*) and the API (/api/*)
    # are served from different ingress hostnames so the browser chat widget points
    # at the correct host.  Leave empty in local dev (falls back to window.location.origin).
    PUBLIC_API_URL: str = ""

    # LangFuse observability (optional — omit all three to disable tracing)
    LANGFUSE_PUBLIC_KEY: str | None = None
    LANGFUSE_SECRET_KEY: str | None = None
    LANGFUSE_BASE_URL: str = "https://cloud.langfuse.com"

    # Sentry error tracking (optional — omit DSN to disable)
    SENTRY_DSN: str | None = None
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1

    # Prometheus metrics (optional — set to true to expose /metrics)
    PROMETHEUS_ENABLED: bool = False

    # Site allowlist — when true, POST /auth/session is rejected unless site_url
    # matches an admin-managed pattern (see SiteAllowlist). Enable on test/staging
    # to contain Anthropic-key abuse; keep false in production. Independent of
    # DEV_BYPASS_LICENSE: the allowlist is enforced even when the bypass is on.
    AUTH_SITE_ALLOWLIST_ENABLED: bool = False

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def is_production(self) -> bool:
        return self.ENV == "production"

    @property
    def pg_dsn(self) -> str:
        """Plain psycopg DSN (postgresql://...) derived from the SQLAlchemy DATABASE_URL.

        SQLAlchemy requires the +asyncpg driver prefix; psycopg_pool requires it absent.
        """
        return self.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
