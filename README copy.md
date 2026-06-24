# WordPress AI Platform (WAP)

WAP is a hosted AI assistant platform that embeds a product-aware AI chat interface into WordPress admin dashboards. Products like WP Rocket and RankMath use it to give their users an AI expert that can read and modify their WordPress configuration over a secured MCP connection.

## Documentation

Start with [docs/architecture.md](docs/architecture.md) for a full system overview.

| Doc | Contents |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | System overview, tech stack, repo layout, DB schema |
| [docs/data-flows.md](docs/data-flows.md) | Step-by-step request flows: auth, chat, tool calls, admin operations |
| [docs/agent-management.md](docs/agent-management.md) | How agents, roles, and snippets work; Admin API reference |
| [docs/admin-ui.md](docs/admin-ui.md) | Browser admin GUI, access, operations runbook |
| [docs/integrating-a-product.md](docs/integrating-a-product.md) | How to onboard a new WordPress product plugin |
| [docs/local-development.md](docs/local-development.md) | First-time setup, env vars, running tests |

## Quick start

```bash
cp .env.example .env
# Set ANTHROPIC_API_KEY, SESSION_ENCRYPTION_KEY, ADMIN_API_KEY, DEV_BYPASS_LICENSE=true

docker-compose up

docker-compose exec py-app alembic upgrade head
docker-compose exec py-app python seed.py
docker-compose exec py-app python scripts/create_admin_user.py
```

Admin UI: http://localhost:8000/admin  
API docs: http://localhost:8000/docs
