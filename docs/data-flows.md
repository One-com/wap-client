# Data Flows

This document traces every major request path through the system.

---

## 1. User starts a chat session (authentication)

Triggered once per page load by the PHP plugin (server-side).

```
WordPress admin PHP (server-side)
  │
  ├── AppPasswordManager checks user meta for stored app password
  │     └── If missing: provisions one via POST /wp-json/wp/v2/users/{id}/application-passwords
  │
  └── POST https://wap.example.com/api/v1/auth/session
        {
          product:          "wp-rocket",
          license_key:      "...",
          site_url:         "https://client.example.com",
          wp_username:      "admin",
          wp_app_password:  "xxxx xxxx xxxx xxxx",
          mcp_endpoint:     "https://client.example.com/wp-json/mcp/v1"
        }

WAP Backend — auth.py
  │
  ├── 1. License validation
  │       LicenseVerifierFactory.get(product).verify(license_key, site_url)
  │       → external HTTP call to product license API
  │       → DEV_BYPASS_LICENSE=true skips this
  │
  ├── 2. WP credential validation
  │       GET {site_url}/wp-json/wp/v2/users/me
  │       Authorization: Basic base64(wp_username:wp_app_password)
  │       → must return 200 (proves app password is valid)
  │
  ├── 3. Derive stable user_id
  │       SHA-256(site_url + ":" + wp_user_id from WP response)[:32]
  │
  ├── 4. Persist credentials (encrypted)
  │       UPSERT site_credentials
  │         user_id, site_url, product, wp_username,
  │         encrypted_wp_app_password (AES-256-GCM),
  │         mcp_endpoint
  │
  ├── 5. Issue session token
  │       token = secrets.token_hex(32)
  │       Redis SET session:{SHA-256(token)} → {user_id, product, site_url, role, mode}
  │       TTL = 600s (fixed — not refreshed on subsequent requests)
  │       JS re-auths automatically on 401, so a 10-minute window is sufficient
  │       and shrinks the stolen-token blast radius compared to a longer TTL
  │
  └── Response: { token, ttl: 600, mode, agent: { id, name, model } }

PHP plugin stores token in WordPress transient (per-user).
Browser JS receives token via inline page data — never handles credentials.
```

---

## 2. User sends a chat message

Triggered by the browser JS chat widget on every user message.

```
Browser (wap-chat.js)
  │
  └── POST /api/v1/chat/stream
        Authorization: Bearer {token}
        Content-Type: application/json
        { "message": "How do I improve my cache hit rate?" }

WAP Backend — chat.py
  │
  ├── 1. Authenticate
  │       SessionAuthMiddleware: SHA-256(token) → Redis lookup → SessionData
  │       → 401 if missing or expired
  │       Redis TTL refreshed to 3600s on every valid request
  │
  ├── 2. Rate limit
  │       RateLimiter.check(user_id) — sliding 60s window in Redis
  │       → 429 if exceeded
  │
  ├── 3. Resolve agent
  │       AgentRegistry.get_by_role(role_for_session(session))
  │       → AgentDefinition with fully-resolved system prompt (snippets already substituted)
  │       Note: session TTL is fixed (600s) — not refreshed on this request
  │
  ├── 4. Load WP credentials
  │       SELECT site_credentials WHERE user_id = ... AND product = ...
  │       → decrypt encrypted_wp_app_password (AES-256-GCM)
  │
  ├── 5. Open MCP connection
  │       WpConnectionService.mcp_tools_context(site_url, mcp_endpoint, wp_username, app_password)
  │       → SSRF validation: mcp_endpoint hostname must match site_url domain, no private IPs
  │       → MultiServerMCPClient connects, fetches tool manifest from WordPress
  │       → graceful fallback: if connection fails, returns empty tool list
  │
  ├── 6. Resolve tools
  │       lib/tools.resolve_tools(agent.tools, mcp_tools, extra_tools)
  │       → maps tool descriptors to LangChain BaseTool instances
  │       → MCP tools can be allowlisted: {"type": "mcp", "allow": ["read_option"]}
  │
  ├── 7. Build and run agent
  │       SingleAgentGraph(agent_def, tools, checkpointer)
  │       thread_id = "{user_id}:{role}"   ← one conversation per user+role
  │       graph.astream({"messages": [user_message]}, config={"thread_id": thread_id})
  │       → LangGraph ReAct loop: LLM call → tool call(s) → LLM call → …
  │
  ├── 8. Stream SSE events to browser
  │       message_start  { conversationId, mode }
  │       text_delta     { delta }             ← one per token chunk
  │       tool_use       { tool, input }        ← when agent calls a WP tool
  │       tool_result    { tool, output }       ← after tool returns
  │       message_end    { usage }
  │       data: [DONE]
  │
  └── 9. Post-stream: opportunistic summarization (async, non-blocking)
        ConversationSummarizer.maybe_summarize(thread_id)
        → if message count > 20: call global:summarizer agent
        → replace checkpoint: [SystemMessage(summary)] + last 2 messages
```

---

## 3. Agent calls a WordPress tool (inside step 7)

During the LangGraph ReAct loop, the agent may invoke MCP tools.

```
LangGraph agent (inside WAP backend)
  │
  └── Tool call: read_option { key: "wp_rocket_settings" }

langchain-mcp-adapters
  │
  └── POST {mcp_endpoint}
        Authorization: Basic base64(wp_username:app_password)
        { "tool": "read_option", "input": { "key": "wp_rocket_settings" } }

WordPress MCP Adapter plugin
  │
  └── wp_get_option("wp_rocket_settings") → returns value

  Response: { "content": [{ "type": "text", "text": "{...}" }] }

LangGraph continues the ReAct loop with tool result as context.
```

---

## 4. Admin updates an agent

Performed via the admin UI browser form or direct API call.

```
Admin browser (or API client)
  │
  └── PUT /admin/agents/{id}
        Authorization: Bearer {ADMIN_API_KEY}
        { slug, name, system_prompt, temperature, model, tools, ... }

WAP Backend — admin.py
  │
  ├── 1. Validate input (Pydantic schema)
  ├── 2. Resolve any {{snippet:key}} placeholders to check they exist
  ├── 3. UPDATE agents SET ... WHERE id = {id}
  └── 4. AgentRegistry.reload(agent_id)
            → re-fetches agent from DB
            → resolves snippet placeholders
            → updates in-memory dict

Next chat request to this agent picks up new definition — no restart needed.
In-flight streaming requests finish with the old agent definition.
```

---

## 5. Admin remaps a role

Changes which agent serves a given role (e.g., A/B testing a new agent).

```
PUT /admin/roles/{role}
  { "agent_id": "new-uuid" }

→ UPDATE agent_role_map SET agent_id = new-uuid WHERE role = {role}
→ AgentRegistry.reload_role(role) — updates in-memory role→agent mapping

All new chat requests for this role use the new agent immediately.
```

---

## 6. User requests GDPR data erasure

The session token stays in JS memory throughout — it is never relayed through WordPress AJAX or PHP.

```
Browser JS (wap-chat.js) — triggered on "erase my data" or WP account deletion
  │
  ├── POST /api/v1/me/data/erase
  │     Authorization: Bearer {token}
  │     (POST alias used because Chrome Private Network Access blocks
  │      DELETE from localhost:port → localhost:port)
  │
  │   WAP Backend — me.py
  │     ├── DELETE site_credentials WHERE user_id = ...
  │     ├── DELETE all LangGraph checkpoint rows for threads starting with user_id
  │     │     (uses fresh AsyncPostgresSaver instances to avoid lock deadlock)
  │     └── DELETE {session key} from Redis
  │
  └── WordPress AJAX: wap_client_delete_data (no token passed)
        PHP GdprHandler — purges WP Application Passwords stored for this user
        No WAP backend call from PHP — all backend calls happen from JS above
```

---

## SSE event reference

All events follow `text/event-stream` format.

```
data: {"type": "message_start", "conversationId": "uid:wp-rocket:standard", "mode": "product"}

data: {"type": "text_delta", "delta": "Your cache"}
data: {"type": "text_delta", "delta": " hit rate depends on..."}

data: {"type": "tool_use", "tool": "read_option", "input": {"key": "wp_rocket_settings"}}
data: {"type": "tool_result", "tool": "read_option", "output": "{\"cache_lifespan\":10}"}

data: {"type": "text_delta", "delta": "Your current lifespan is 10 hours."}

data: {"type": "message_end", "usage": {"input_tokens": 1234, "output_tokens": 87}}

data: [DONE]
```

On error, a single event is emitted before closing the stream:
```
data: {"type": "error", "code": "rate_limited", "message": "Too many requests"}
```

---

## Thread identity and conversation continuity

LangGraph persists conversation history per thread. The thread ID format is:

```
{user_id}:{role}
```

Where `user_id = SHA-256(site_url + ":" + wp_user_id)[:32]`.

This means:
- One persistent conversation per user per role
- History survives browser refresh, page navigation, and session token renewal
- Different products (wp-rocket vs rankmath) have separate conversations even for the same WP user
- Conversation history is automatically loaded as context at the start of each message
