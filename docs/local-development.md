# Local Development

---

## Prerequisites

- Docker + Docker Compose
- Python 3.12+ (for running scripts outside the container)
- `curl` or a REST client (for testing API endpoints)

---

## First-time setup

### 1. Copy and configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
```ini
ANTHROPIC_API_KEY=sk-ant-...
SESSION_ENCRYPTION_KEY=<32-byte random value, base64-encoded>
ADMIN_API_KEY=local-admin-key
DEV_BYPASS_LICENSE=true          # skips license + WP credential checks
AUTH_SITE_ALLOWLIST_ENABLED=true # optional: enable site allowlist gate
```

Generate a valid encryption key:
```bash
python3 -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
```

### 2. Start services

```bash
docker-compose up
```

This starts:
- **postgres:16** on port 5433
- **redis:7** on port 6379
- **py-app** (FastAPI with hot-reload) on port 8000

The first startup automatically creates LangGraph checkpoint tables. Wait for the log line:
```
INFO [WAP] Python/LangGraph backend started on port 8000
```

### 3. Run database migrations

```bash
docker-compose exec py-app alembic upgrade head
```

### 4. Seed sample data

```bash
docker-compose exec py-app python seed.py
```

This inserts sample agents, prompt snippets, and role mappings so the system is immediately usable.

### 5. Create an admin user

```bash
docker-compose exec py-app python scripts/create_admin_user.py
```

Then open http://localhost:8000/admin/login.

---

## Verify the setup

```bash
# Health check
curl http://localhost:8000/health

# List agents (should return seeded data)
curl http://localhost:8000/admin/agents \
  -H "Authorization: Bearer local-admin-key"

# Create a test session (DEV_BYPASS_LICENSE=true skips license check)
curl -X POST http://localhost:8000/api/v1/auth/session \
  -H "Content-Type: application/json" \
  -d '{
    "product": "wp-rocket",
    "license_key": "dev-key",
    "site_url": "https://test.example.com",
    "wp_username": "admin",
    "wp_app_password": "xxxx xxxx xxxx xxxx",
    "mcp_endpoint": "https://test.example.com/wp-json/mcp/v1"
  }'
```

With `DEV_BYPASS_LICENSE=true`, both the license validation step and the WP App Password check are skipped (the backend won't try to call `test.example.com`). You'll get back a session token you can use for chat testing. A warning is logged every time a session is created via this bypass.

If `AUTH_SITE_ALLOWLIST_ENABLED=true`, the site allowlist gate runs first regardless of the bypass — add an entry for `https://test.example.com` via the admin UI (`/admin/ui/allowlist`) before testing.

---

## Development workflow

### Hot-reload

The `py-app` service mounts `./py-backend/app` into the container. Any file save triggers uvicorn to reload the app automatically. No restart needed for code changes.

### Running tests

```bash
docker-compose exec py-app pytest
```

Or against a specific file:
```bash
docker-compose exec py-app pytest tests/test_agent_registry.py -v
```

### Database migrations

Generate a new migration after changing `app/db/models.py`:
```bash
docker-compose exec py-app alembic revision --autogenerate -m "describe_your_change"
docker-compose exec py-app alembic upgrade head
```

### Accessing the DB directly

```bash
docker-compose exec postgres psql -U wap -d wap
```

### Accessing Redis

```bash
docker-compose exec redis redis-cli
```

---

## Environment variables reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | `postgresql+asyncpg://wap:wap@postgres:5432/wap` |
| `REDIS_URL` | Yes | — | `redis://redis:6379` |
| `SESSION_ENCRYPTION_KEY` | Yes | — | AES-256-GCM key, base64-encoded 32 bytes |
| `ADMIN_API_KEY` | Yes | — | Bearer token for admin API endpoints |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Override for local proxy/testing |
| `WP_ROCKET_LICENSE_API_URL` | No | — | Required if `DEV_BYPASS_LICENSE=false` |
| `RANKMATH_LICENSE_API_URL` | No | — | Required if `DEV_BYPASS_LICENSE=false` |
| `DEV_BYPASS_LICENSE` | No | `false` | Set `true` in local dev to skip license + WP credential validation (logs a warning on each bypass) |
| `AUTH_SITE_ALLOWLIST_ENABLED` | No | `false` | Set `true` to enforce the admin-managed site allowlist gate on session creation |
| `ALLOWED_ORIGINS` | No | `*` in dev | Comma-separated CORS origins |
| `LANGFUSE_PUBLIC_KEY` | No | — | Omit to disable LangFuse tracing |
| `LANGFUSE_SECRET_KEY` | No | — | Omit to disable LangFuse tracing |
| `LANGFUSE_BASE_URL` | No | `https://cloud.langfuse.com` | LangFuse endpoint |
| `SENTRY_DSN` | No | — | Omit to disable Sentry error tracking |
| `SENTRY_TRACES_SAMPLE_RATE` | No | `0.1` | Fraction of requests traced in Sentry |
| `PROMETHEUS_ENABLED` | No | `false` | Set `true` to expose `/metrics` endpoint |
| `PORT` | No | `8000` | Backend port |

---

## Project-specific notes

- The Postgres port is **5433** (not 5432) in docker-compose to avoid conflicts with locally installed Postgres.
- `DEV_BYPASS_LICENSE=true` skips both the license API call and the WP App Password check. Every session created this way emits a `WARNING` log. Never set this to `true` in production or staging.
- If `AUTH_SITE_ALLOWLIST_ENABLED=true`, the allowlist is enforced even when `DEV_BYPASS_LICENSE=true` — you must add matching patterns via the admin UI before testing.
- The `seed.py` script is idempotent — safe to run multiple times.
- LangGraph checkpoint tables are created automatically on startup via `AsyncPostgresSaver.setup()`.

---

## CI pipeline

The GitLab CI pipeline (`.gitlab-ci.yml`) runs three stages on every push:

1. **lint** — `ruff check`, `ruff format --check`, `mypy`, `pylint`. All must pass (`allow_failure: false`).
2. **test** — `pytest` with real Postgres 16 and Redis 7 service containers. Coverage must be ≥ 60%.
3. **build** — Docker image built and pushed to the registry. Runs on `main` branch only.

Run the same checks locally before pushing:
```bash
docker-compose exec py-app ruff check app/ tests/
docker-compose exec py-app mypy app/
docker-compose exec py-app pylint app/
docker-compose exec py-app pytest tests/ --cov=app --cov-fail-under=60
```

---

## Test suite layout

```
py-backend/tests/
├── test_session_service.py     # Token creation, validation, revocation
├── test_agent_registry.py      # Snippet resolution, role mapping, hot-reload
├── test_routes_auth.py         # Session creation endpoint, license validation
├── test_routes_chat.py         # Streaming endpoint, history retrieval
├── test_tools.py               # Tool resolution, MCP connection
├── test_encryption.py          # AES-256-GCM encrypt/decrypt
├── test_summarizer.py          # Conversation compression
└── test_site_allowlist.py      # Allowlist matching logic + session gate
```
