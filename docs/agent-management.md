# Agent Management

This document covers how AI agents are defined, configured, deployed, and updated.

---

## Concepts

### Agent

An **agent** is an AI assistant configuration stored in the `agents` table. It defines:
- Which LLM model to use
- The system prompt (with optional snippet references)
- Which tools are available
- Behavioral parameters (temperature, max_turns)

Agents are never deleted. An agent with no role mapping is a **draft** — it exists in the DB but no user ever invokes it.

### Role

A **role** is a string that maps to exactly one agent. Roles decouple users from specific agents — the platform routes requests by role, not agent ID. This lets you hot-swap agents (e.g., for A/B tests) without touching auth sessions.

Well-known role format: `{product}:{mode}`

| Role | Purpose |
|------|---------|
| `wp-rocket:standard` | WP Rocket product specialist |
| `rankmath:standard` | RankMath product specialist |
| `global:orchestrator` | Multi-product router (decides which specialist to call) |
| `global:synthesis` | Synthesizes outputs from multiple specialists |
| `global:summarizer` | Internal — compresses long conversation histories |

### Prompt Snippet

A **prompt snippet** is a named block of reusable text referenced inside system prompts as `{{snippet:key}}`. Snippets are resolved at `AgentRegistry` load time.

Use snippets for:
- Legal disclaimers shared across all agents
- Product knowledge bases that are updated independently
- Security policies applied to multiple agents

---

## Agent definition fields

```json
{
  "slug": "wp-rocket-standard-v3",
  "name": "WP Rocket Performance Expert v3",
  "product_slug": "wp-rocket",
  "provider": "anthropic",
  "model": "claude-opus-4-1",
  "system_prompt": "You are a WP Rocket performance expert...\n\n{{snippet:wp_rocket_knowledge}}\n\n{{snippet:security_policy}}",
  "temperature": 0.3,
  "max_turns": 25,
  "tools": [
    {"type": "mcp"},
    {"type": "builtin", "name": "web_fetch"}
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | Yes | Unique, kebab-case. Use versioning: `wp-rocket-standard-v2` |
| `name` | Yes | Human-readable label shown in admin UI |
| `product_slug` | Yes | Matches license verification product names |
| `provider` | Yes | Always `"anthropic"` for now |
| `model` | Yes | Anthropic model ID. See [claude-api skill] for current models |
| `system_prompt` | Yes | Can include `{{snippet:key}}` references |
| `temperature` | No | Default `0.3`. Lower = more deterministic |
| `max_turns` | No | Default `25`. ReAct loop recursion limit |
| `tools` | No | `null` = no tools. Array = mix of MCP and built-in |

---

## Tool descriptors

The `tools` JSONB array controls which tools the agent can use. Three types:

### MCP tools (from WordPress)

```json
{"type": "mcp"}
```
Gives the agent access to **all** tools the WordPress MCP adapter exposes for this site.

To restrict to specific tools (recommended for production):
```json
{"type": "mcp", "allow": ["read_option", "update_option", "get_post"]}
```

The `allow` list is an allowlist — any MCP tool not named here is blocked.

### Built-in tools

```json
{"type": "builtin", "name": "web_fetch"}
```

| Name | What it does |
|------|-------------|
| `web_fetch` | HTTP GET any URL (SSRF-guarded, no private IPs) |
| `invoke_specialist` | For orchestrator agents — calls a specialist by role |

### Combining tools

```json
[
  {"type": "mcp", "allow": ["read_option", "get_post"]},
  {"type": "builtin", "name": "web_fetch"}
]
```

---

## AgentRegistry — how agents are loaded

`AgentRegistry` (`app/services/agent_registry.py`) is the in-process cache. It:

1. At startup: loads all agents, snippets, and role mappings from DB
2. Resolves all `{{snippet:key}}` placeholders — **fails loudly** if any key is missing
3. Caches resolved `AgentDefinition` objects in memory (dict keyed by agent UUID)
4. Maps roles to agent IDs in a separate dict

At chat time, the route calls:
```python
agent = agent_registry.get_by_role("wp-rocket:standard")
```
This is an in-memory lookup — zero DB queries per chat request.

**Hot-reload:** After any admin write operation (PUT agent, PUT role, PUT snippet), the route calls `agent_registry.reload(agent_id)` or `agent_registry.reload_role(role)`. This re-fetches from DB and re-resolves snippets without restarting the server.

**Multi-pod synchronization:** In a multi-replica deployment, the pod handling the admin request publishes a small JSON invalidation message to a Redis pub/sub channel. Every other pod subscribes and applies the same reload locally within <1 second. The `/health` readiness probe monitors the pub/sub subscriber; if it goes silent for >30 seconds, the pod is pulled from the load balancer rotation until Redis recovers.

---

## Admin API — managing agents

All routes require `Authorization: Bearer {ADMIN_API_KEY}`.

### Agents

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `GET` | `/admin/agents` | — | List all agents |
| `POST` | `/admin/agents` | Agent object | Create agent |
| `GET` | `/admin/agents/{id}` | — | Get single agent |
| `PUT` | `/admin/agents/{id}` | Agent fields | Update + reload registry |
| `DELETE` | `/admin/agents/{id}` | — | Delete (403 if role mapped) |

### Role mappings

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `GET` | `/admin/roles` | — | List all role mappings |
| `PUT` | `/admin/roles/{role}` | `{"agent_id": "uuid"}` | Map role → agent (hot-swap) |
| `DELETE` | `/admin/roles/{role}` | — | Unmap role |

### Prompt snippets

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `GET` | `/admin/snippets` | — | List all snippets |
| `POST` | `/admin/snippets` | `{key, content}` | Create snippet |
| `PUT` | `/admin/snippets/{key}` | `{content}` | Update + reload all affected agents |
| `DELETE` | `/admin/snippets/{key}` | — | Delete (403 if referenced by any agent) |

---

## Admin UI

The admin UI at `/admin/ui/agents` is a browser-based interface for managing agents, roles, and snippets. See [admin-ui.md](admin-ui.md) for details on access and usage.

---

## Chat modes

The `mode` field on a session determines the routing logic inside the backend:

| Mode | Behavior |
|------|---------|
| `product` | Routes to `{product}:standard` agent. One-shot specialist. |
| `orchestrator` | Routes to `global:orchestrator`. Agent may use `invoke_specialist` to call product agents. |

Mode is determined at session creation based on the product and license tier. It is stored in the session and cannot be changed without re-authenticating.

---

## Conversation summarization

When a conversation exceeds 20 messages, the `ConversationSummarizer` automatically compresses history:

1. Calls the `global:summarizer` agent with the full conversation
2. Replaces the LangGraph checkpoint with: `[SystemMessage(summary)] + last 2 messages`
3. This runs as `asyncio.create_task()` after each streaming response — non-blocking

This keeps the context window manageable for long-running conversations without losing thread continuity.

---

## Adding a new agent (step by step)

1. **Create a prompt snippet** (if the system prompt needs reusable content):
   ```bash
   curl -X POST https://wap.example.com/admin/snippets \
     -H "Authorization: Bearer $ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"key": "my_product_knowledge", "content": "..."}'
   ```

2. **Create the agent**:
   ```bash
   curl -X POST https://wap.example.com/admin/agents \
     -H "Authorization: Bearer $ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "slug": "my-product-standard-v1",
       "name": "My Product Expert",
       "product_slug": "my-product",
       "provider": "anthropic",
       "model": "claude-opus-4-1",
       "system_prompt": "You are an expert...\n\n{{snippet:my_product_knowledge}}",
       "temperature": 0.3,
       "max_turns": 25,
       "tools": [{"type": "mcp"}]
     }'
   ```

3. **Map the role**:
   ```bash
   curl -X PUT https://wap.example.com/admin/roles/my-product:standard \
     -H "Authorization: Bearer $ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"agent_id": "uuid-from-step-2"}'
   ```

New sessions for `product: "my-product"` will now resolve to this agent.

---

## Iterating on a live agent

To update a prompt without disrupting active users:

1. Create a new agent (`my-product-standard-v2`) with the new prompt
2. Verify it looks correct via `GET /admin/agents/{new-id}`
3. Remap the role:
   ```
   PUT /admin/roles/my-product:standard  { "agent_id": "new-uuid" }
   ```

In-flight streaming requests continue with the old agent definition. New requests immediately use the new agent. No restart, no downtime.
