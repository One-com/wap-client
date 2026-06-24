# Architecture

## What WAP does

WAP lets WordPress product vendors (WP Rocket, RankMath, …) embed a product-aware AI assistant into the WordPress admin dashboard. The assistant:

- Knows the product's configuration via a curated system prompt
- Can read and update WordPress settings over an MCP connection scoped to the current site
- Maintains conversation history per user, per product
- Supports multiple independent chat modes (product specialist, orchestrator, etc.)

---

## High-level components

```
┌─────────────────────────────────────────────────────────────┐
│  WordPress admin (browser)                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  wap-client PHP library (vendor'd in product plugin) │   │
│  │  ┌──────────────┐  ┌───────────────────────────────┐ │   │
│  │  │ ChatWidget   │  │ ApiClient                     │ │   │
│  │  │ (JS/CSS)     │  │ (PHP, runs server-side)       │ │   │
│  │  └──────────────┘  └───────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
    Bearer token (SSE)     │   session exchange (PHP→Python)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  WAP Backend  (Python / FastAPI)                            │
│                                                             │
│  Routes        Services            Infra                    │
│  ────────────  ──────────────────  ──────────────────────   │
│  auth.py       SessionService      PostgreSQL               │
│  chat.py       AgentRegistry         • agents               │
│  admin.py      WpConnectionService   • site_credentials     │
│  admin_ui.py   LicenseVerifier       • agent_role_map       │
│  me.py         RateLimiter           • prompt_snippets      │
│  health.py     ConversationSummarizer• admin_users          │
│                                    Redis                    │
│  Agents                              • session tokens        │
│  ────────────                        • rate limit windows   │
│  SingleAgentGraph (LangGraph)      LangGraph Checkpointer   │
│                                      (Postgres)             │
└──────────────────────────┬──────────────────────────────────┘
    HTTP Basic (app pw)    │   MCP over HTTP
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  WordPress site (per-customer)                              │
│  WordPress MCP Adapter plugin                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WP REST API endpoints exposed as MCP tools          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| API framework | FastAPI (async) |
| Agent runtime | LangGraph (ReAct loop) |
| LLM | Anthropic Claude (via `langchain-anthropic`) |
| WordPress integration | MCP via `langchain-mcp-adapters` |
| Database | PostgreSQL 16 (SQLAlchemy 2 async) |
| Conversation persistence | LangGraph Postgres checkpointer |
| Session / rate-limit store | Redis 7 |
| Encryption | AES-256-GCM (app passwords at rest) |
| Admin UI | Jinja2 + HTMX |
| WordPress plugin | PHP 7.4+, Composer |
| Observability | LangFuse tracing, Sentry errors, Prometheus metrics, structlog (all optional) |

---

## Repository layout

```
wordpress-agentic-platform-poc/
├── py-backend/                 # Python backend (the main codebase)
│   ├── app/
│   │   ├── main.py             # FastAPI bootstrap, dependency wiring
│   │   ├── config.py           # Settings (pydantic-settings, reads .env)
│   │   ├── db/
│   │   │   ├── database.py     # SQLAlchemy engine + session factory
│   │   │   └── models.py       # ORM models (Agent, SiteCredential, etc.)
│   │   ├── routes/
│   │   │   ├── auth.py         # POST /api/v1/auth/session
│   │   │   ├── chat.py         # POST /api/v1/chat/stream
│   │   │   ├── admin.py        # CRUD API (ADMIN_API_KEY protected)
│   │   │   ├── admin_ui.py     # Browser admin GUI
│   │   │   ├── me.py           # User self-service (GDPR erasure)
│   │   │   └── health.py       # GET /health
│   │   ├── agents/
│   │   │   └── single_agent.py # LangGraph ReAct agent wrapper
│   │   ├── services/
│   │   │   ├── agent_registry.py       # In-process agent cache
│   │   │   ├── session_service.py      # Redis session tokens
│   │   │   ├── admin_session_service.py# Admin GUI sessions
│   │   │   ├── wp_connection_service.py# MCP connection + SSRF guard
│   │   │   ├── license_verifier.py     # Product license validation
│   │   │   ├── rate_limiter.py         # Sliding-window rate limit
│   │   │   ├── summarizer.py           # Conversation compression
│   │   │   └── conversation_service.py # Thread lifecycle helpers
│   │   ├── lib/
│   │   │   ├── encryption.py   # AES-256-GCM helpers
│   │   │   ├── password.py     # bcrypt helpers
│   │   │   ├── tools.py        # Tool resolution (MCP + built-ins)
│   │   │   ├── sse.py          # SSE event formatters
│   │   │   ├── text.py         # Shared text-extraction utility
│   │   │   └── observability.py# LangFuse, Sentry, Prometheus setup
│   │   ├── middleware/
│   │   │   └── session_auth.py # Bearer token validation middleware
│   │   ├── templates/admin/    # Jinja2 HTML templates
│   │   └── static/admin/       # CSS / static assets
│   ├── alembic/                # DB migrations
│   ├── seed.py                 # Local dev seed data
│   ├── scripts/
│   │   └── create_admin_user.py
│   ├── Dockerfile
│   └── pyproject.toml
│
├── wp-client-plugin/           # WordPress PHP client library
│   └── wap-client/
│       ├── wap-client.php      # Plugin entry point
│       └── includes/
│           ├── class-api-client.php
│           ├── class-app-password-manager.php
│           ├── class-chat-widget.php
│           └── class-gdpr-handler.php
│
├── docs/                       # This directory
├── docker-compose.yml
└── .env.example
```

---

## Database schema

```
agents
  id (UUID PK)
  slug (unique)
  name
  product_slug          ← "wp-rocket", "rankmath", "global"
  provider              ← "anthropic"
  model                 ← "claude-opus-4-1", etc.
  system_prompt         ← may contain {{snippet:key}} placeholders
  temperature
  max_turns             ← ReAct loop recursion limit
  tools (JSONB)         ← [{"type": "mcp"}, {"type": "builtin", "name": "web_fetch"}]
  created_at / updated_at

agent_role_map
  role (PK)             ← "wp-rocket:standard", "global:orchestrator", …
  agent_id (FK → agents)
  updated_at

prompt_snippets
  id (UUID PK)
  key (unique)          ← referenced as {{snippet:key}} in prompts
  content
  updated_at

site_credentials
  id (UUID PK)
  user_id               ← SHA-256(site_url + ":" + wp_user_id)[:32]
  site_url
  product
  wp_username
  encrypted_wp_app_password  ← AES-256-GCM
  mcp_endpoint
  created_at / updated_at

admin_users
  id (UUID PK)
  email (unique)
  hashed_password       ← bcrypt
  display_name
  created_at / updated_at

site_allowlist
  id (UUID PK)
  pattern (unique)      ← e.g. "https://*.example.com" (fnmatch wildcards)
  description
  created_at / updated_at
```

**LangGraph tables** (created automatically by `AsyncPostgresSaver.setup()`):
`checkpoints`, `checkpoint_blobs`, `checkpoint_writes` — stores full conversation state per thread.

---

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| **Agent resolved at chat time** | Admins can swap agents without requiring users to re-authenticate |
| **Session token SHA-256 hashed in Redis** | Token leak exposes nothing; revocation is a single `DEL` |
| **WP Application Password for MCP auth** | Standard server-to-server auth; does not expire; supports HTTP Basic |
| **Per-request MCP connection** | WordPress sites go offline; pools would hold dead connections. The ~200ms reconnect overhead is invisible against LLM latency |
| **License validated once at session creation** | External license APIs are slow and rate-limited |
| **Conversation summarization is non-blocking** | Runs as `asyncio.create_task()` after streaming ends; never delays the response |
| **Prompt snippet resolution fails loudly at startup** | Missing snippets surface immediately, not silently at runtime |
| **Agents are never deleted** | Unmapped agents act as drafts; deletion is prevented if a role mapping exists |
| **AsyncPostgresSaver instantiated per-request** | Sharing one instance serializes all DB ops through a single `asyncio.Lock`, causing deadlocks under concurrent requests. A fresh instance per request uses the same shared connection pool but gets its own lock |
| **`DEV_BYPASS_LICENSE` handled in `auth.py`, not in `LicenseVerifier`** | All security-relevant conditional paths live in one place (the route handler), mirroring how the WP App Password bypass is handled. The service layer stays pure — no awareness of dev/prod mode. Each bypassed step emits a `WARNING` log; a final warning fires when the session is actually created via bypass. |
| **Site allowlist enforced regardless of `DEV_BYPASS_LICENSE`** | The allowlist is an independent abuse-prevention gate for test/staging. With bypass on, `site_url` is unverified (no WP credential check), so the allowlist gates a *claimed* URL — still blocks arbitrary callers. With bypass off, the WP App Password check proves control of the site, making the gate stronger. Enabled via `AUTH_SITE_ALLOWLIST_ENABLED`; fail-closed (empty table denies all). |
