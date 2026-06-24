# WAP Python Backend — multi-stage Dockerfile
#
# Stages:
#   base  — shared OS deps + uv
#   deps  — Python package install (cached layer)
#   dev   — hot-reload for local development
#   prod  — hardened production image (non-root, no dev extras)
#
# Build prod image:
#   docker build --target prod -t wap-backend:latest .
#
# Run locally (requires .env):
#   docker run --env-file ../.env -p 8000:8000 wap-backend:latest

ARG PYTHON_VERSION=3.12

# ── base: minimal Python with uv ─────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS base

# libpq5 is required by psycopg (async Postgres driver)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir uv

WORKDIR /app

# ── deps: install Python dependencies in a cached layer ──────────────────────
FROM base AS deps

COPY pyproject.toml .
# Install all deps (including uvicorn) without dev extras
RUN uv pip install --system "uvicorn[standard]" && \
    uv pip install --system -e "."

# ── dev: adds hot-reload for local development ────────────────────────────────
FROM deps AS dev

COPY . .

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# ── prod: hardened image — non-root user, no dev extras ──────────────────────
FROM deps AS prod

COPY . .

# Non-root user — required for most container security policies
RUN groupadd --system --gid 1001 wap && \
    useradd --system --uid 1001 --gid wap --no-create-home wap && \
    chown -R wap:wap /app

USER wap

EXPOSE 8000

# Liveness probe: GET /health must return 200
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# workers=1: LangGraph checkpointer pool is in-process; multi-worker needs an external pool
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--access-log"]
