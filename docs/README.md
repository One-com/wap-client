# WordPress AI Platform (WAP) — Documentation

WAP is a hosted AI assistant platform that embeds an AI chat interface into WordPress admin dashboards for products like WP Rocket and RankMath. Users get a product-aware AI agent that can read and modify their WordPress site through a secured MCP connection.

## Docs index

| File | Who should read it |
|------|--------------------|
| [architecture.md](architecture.md) | Everyone — start here |
| [data-flows.md](data-flows.md) | Backend devs, PM understanding the system |
| [agent-management.md](agent-management.md) | AI/backend devs, PMs managing agents |
| [admin-ui.md](admin-ui.md) | Backend devs, ops managing the platform |
| [integrating-a-product.md](integrating-a-product.md) | Devs onboarding a new WordPress product |
| [local-development.md](local-development.md) | All devs setting up locally |

## Quick orientation

```
WordPress admin browser
        │  Bearer token (session)
        ▼
  WAP Backend (FastAPI/Python)
        │  MCP over HTTP
        ▼
  WordPress MCP Adapter (per-site WP plugin)
        │  WP REST API
        ▼
  WordPress Database / Settings
```

The backend is the only moving part in this repo. The WordPress client plugin lives in `wp-client-plugin/` and ships as part of product plugins (WP Rocket, RankMath).
