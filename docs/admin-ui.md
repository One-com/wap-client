# Admin UI

The WAP admin UI is a browser-based interface for platform operators to manage agents, role mappings, and prompt snippets. It does not require coding — changes take effect immediately via hot-reload.

---

## Access

The admin UI lives at `/admin/`. Authentication is email + password, separate from the API key.

**Creating an admin user** (first-time setup or new operator):
```bash
docker-compose exec py-app python scripts/create_admin_user.py
```
You will be prompted for email, display name, and password.

Once logged in, the session is maintained via an `HttpOnly, SameSite=Strict` cookie. Sessions expire after inactivity (Redis-backed, configurable TTL).

The admin API key (`ADMIN_API_KEY` env var) is for programmatic access only — curl, CI scripts, etc. It does not log into the UI.

---

## Pages

### Agents (`/admin/ui/agents`)

Lists all agents in the DB. For each agent you can:
- **View** — slug, name, product, model, temperature, max_turns, tool count
- **Edit** — opens an inline HTMX form with all fields. Changes are `PUT /admin/agents/{id}` under the hood and hot-reload the registry.
- **Delete** — only available if the agent is not mapped to any role

The form validates `{{snippet:key}}` references on save — unknown keys are rejected.

### Roles (`/admin/ui/roles`)

Shows the current role → agent mapping table. For each role you can:
- **Reassign** — select a different agent from a dropdown. Takes effect immediately for new chat requests.
- **Unmap** — removes the mapping (the role returns no agent until remapped)

### Snippets (`/admin/ui/snippets`)

Lists all prompt snippets. For each snippet you can:
- **Edit** — opens an inline form. After save, all agents referencing `{{snippet:key}}` are reloaded.
- **Delete** — only available if no agent references the key

### Chat tester (`/admin/ui/chat`)

Talk to any agent from the admin, using the **exact same chat widget** (`wap-chat.js` /
`wap-chat.css`) that runs on a real WordPress site — so what you see here is representative
of the end-user experience.

How it works:
- Pick a **role** from the dropdown (populated from the current role → agent mappings). The
  page derives the product / mode / page-context a WordPress client would send for that role.
- Optionally fill the **WordPress connection** fields (MCP URL, username, Application
  Password, site URL). Click **Connect** and the widget mounts and streams from the real
  `/api/v1/chat/stream`.
- **Leaving the WP connection fields empty** mints a session with validation bypassed
  *per request* — the agent responds, but WordPress MCP tools are unavailable. This bypass
  is admin-only (gated by the admin session) and does **not** touch the deploy-wide
  `DEV_BYPASS_LICENSE` flag. Fill the fields in to exercise full license + App Password
  validation and live MCP tool calls.

Under the hood the page uses the widget's pluggable auth: it sets
`WapClientConfig.authStrategy = 'direct'` pointing at `POST /admin/chat/session`, which reuses
the same session-creation logic as the public `/api/v1/auth/session` route.

> **Asset sync.** The canonical source for `wap-chat.js` / `wap-chat.css` is the WP plugin
> (`wp-client-plugin/wap-client/assets/`). The backend serves committed copies from
> `py-backend/app/static/admin/` because it is deployed as a standalone image without the
> plugin directory. After editing the WP client assets, run
> `py-backend/scripts/sync_wap_client_assets.sh` and commit the refreshed copies. Run it with
> `--check` to detect drift (e.g. in a pre-commit hook or CI).

---

## Admin API (programmatic)

For CI pipelines, agent deployment scripts, or tooling. All routes require:
```
Authorization: Bearer {ADMIN_API_KEY}
```

See the full route reference in [agent-management.md](agent-management.md#admin-api--managing-agents).

The OpenAPI spec is available at `/docs` (Swagger UI) when running locally, or at [docs/openapi.yaml](openapi.yaml).

---

## Security

- Admin UI sessions use `HttpOnly` cookies — JavaScript cannot read them
- `SameSite=Strict` prevents CSRF from other origins
- `Secure` flag is set in production (requires HTTPS)
- The admin API key is never stored in the DB — it is validated directly from the `ADMIN_API_KEY` env var
- Admin users are bcrypt-hashed — see `app/lib/password.py`

---

## Operations runbook

### Restarting the backend

All in-memory state (AgentRegistry cache) rebuilds from Postgres on startup. Sessions survive a restart (stored in Redis). Conversation history survives (stored in the LangGraph Postgres checkpointer).

### Rolling back an agent change

Remap the role back to the previous agent version — no code change or restart needed.

### Checking active sessions

Sessions are stored in Redis as `session:{SHA-256(token)}`. To count active sessions:
```bash
redis-cli KEYS "session:*" | wc -l
```

### Revoking all sessions for a user

The user's `user_id` is `SHA-256(site_url + ":" + wp_user_id)[:32]`. Sessions include `user_id` in their Redis value, but there is no reverse index — to revoke all sessions for a user, either:
- Have the user call `DELETE /api/v1/me/data` (also erases conversation history)
- Or rotate `SESSION_ENCRYPTION_KEY` (invalidates all sessions platform-wide)

### Enabling observability (LangFuse)

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `.env`. The platform attaches a LangFuse callback handler to every agent run. Unset any of these variables to disable tracing.
