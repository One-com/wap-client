# Playwright MCP Integration

## Context

Adds browser automation capabilities to agents — navigate pages, inspect network requests, read console errors, click UI elements. Useful for troubleshooting rendered behaviour (e.g. verifying WP Rocket's Delay JS, checking if scripts are deferred, catching JS errors).

LangGraph has no native MCP integration. The idiomatic approach — already used for the WordPress MCP adapter — is: `langchain_mcp_adapters.MultiServerMCPClient.get_tools()` converts an MCP server's tools into `BaseTool` instances, which are passed to `create_react_agent()`. This plan adds a second MCP server (Playwright) using the exact same pattern.

No custom `BaseTool` subclass is needed. The Playwright MCP server manages the browser lifecycle. Adding or removing browser capabilities is a server config change, not a code change.

---

## Approach: Playwright MCP sidecar

Run [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) as a sidecar. It speaks standard MCP over HTTP. Tools such as `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_network_requests`, and `browser_console_messages` appear automatically via `get_tools()` as `BaseTool` instances.

Agents opt in via the JSONB `tools` descriptor — same mechanism as `web_fetch` or the WordPress MCP adapter.

---

## What changes

### 1. Infrastructure
Add a `playwright-mcp` service to the compose stack:
```yaml
playwright-mcp:
  image: mcr.microsoft.com/playwright/mcp  # or a Node image running npx @playwright/mcp
  command: ["--port", "3001", "--headless"]
  ports:
    - "3001:3001"
```

### 2. `py-backend/app/config.py`
Add an optional setting:
```python
PLAYWRIGHT_MCP_URL: str | None = None  # e.g. "http://playwright-mcp:3001/mcp"
```

### 3. `py-backend/app/services/browser_connection_service.py` (new file)
Mirrors `WpConnectionService` but for a fixed endpoint with no per-site credentials:
```python
class BrowserConnectionService:
    def __init__(self, settings: Settings) -> None: ...

    @asynccontextmanager
    async def browser_tools_context(self) -> AsyncGenerator[list[BaseTool], None]:
        if not self._settings.PLAYWRIGHT_MCP_URL:
            yield []
            return
        # MultiServerMCPClient({"browser": {"url": PLAYWRIGHT_MCP_URL, "transport": "streamable_http"}})
        # yield await client.get_tools()
```
Returns an empty list when `PLAYWRIGHT_MCP_URL` is unset — agents that declare `mcp_browser` tools simply receive no browser tools in that environment (graceful degradation).

### 4. `py-backend/app/lib/tools.py`
Add `"mcp_browser"` as a new descriptor type in `resolve_tools()`, exactly parallel to `"mcp"`:

```python
elif t == "mcp_browser":
    allow = td.get("allow")
    if allow is None:
        result.extend(browser_tools)
    else:
        filtered = [tool for tool in browser_tools if tool.name in allow]
        # same allow-list warning as "mcp"
        result.extend(filtered)
```

`resolve_tools()` gains a new `browser_tools: list[BaseTool]` parameter (default `[]`).

Example agent descriptor:
```json
{
  "type": "mcp_browser",
  "allow": ["browser_navigate", "browser_screenshot", "browser_network_requests",
             "browser_console_messages", "browser_click"]
}
```

### 5. `py-backend/app/agents/single_agent.py`
- `SingleAgentGraph.__init__` receives an optional `BrowserConnectionService`
- In `stream()` / `generate()`, detect `mcp_browser` in the agent's descriptors:
  ```python
  needs_browser = self._agent_def.tools and any(
      td.get("type") == "mcp_browser" for td in self._agent_def.tools
  )
  ```
- Open the browser tools context and merge into the tool list before calling `resolve_tools()`

### 6. `py-backend/app/routes/chat.py`
Instantiate `BrowserConnectionService` (same pattern as `WpConnectionService`) and inject into `SingleAgentGraph`.

---

## Files to modify

| File | Change |
|---|---|
| `docker-compose.yml` (or infra equivalent) | Add `playwright-mcp` sidecar service |
| `py-backend/app/config.py` | Add `PLAYWRIGHT_MCP_URL: str \| None = None` |
| `py-backend/app/services/browser_connection_service.py` | New — fixed-endpoint MCP context manager, no per-site credentials |
| `py-backend/app/lib/tools.py` | Add `"mcp_browser"` descriptor type + `browser_tools` param to `resolve_tools()` |
| `py-backend/app/agents/single_agent.py` | Accept `BrowserConnectionService`, open browser context when needed |
| `py-backend/app/routes/chat.py` | Instantiate + inject `BrowserConnectionService` |

---

## Verification

1. Start the sidecar: `npx @playwright/mcp --port 3001 --headless`
2. Confirm tools are served: `curl http://localhost:3001/mcp` (or check logs)
3. Set `PLAYWRIGHT_MCP_URL=http://localhost:3001/mcp` in `.env`
4. Configure any agent with `{"type": "mcp_browser"}` in its `tools` JSONB
5. Send a chat message asking the agent to navigate to a URL
6. Confirm SSE `tool_use` events for `browser_navigate` and related tools; `tool_result` events with page data
7. Unit tests: extend `test_tools.py` — cover `mcp_browser` with no allow-list, with allow-list, and graceful empty list when `browser_tools=[]`
