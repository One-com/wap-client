# Integrating a New Product

This guide covers everything needed to onboard a new WordPress product (e.g., a plugin like WP Rocket or RankMath) onto the WAP platform.

Integration involves three parts:
1. **Backend** — license verification + agent configuration
2. **WordPress client plugin** — embed the chat widget in the product's admin dashboard

---

## Part 1: Backend — license verifier

Each product validates its license before issuing a session token.

### 1a. Add a license API URL to config

In `py-backend/app/config.py`, add:
```python
MY_PRODUCT_LICENSE_API_URL: str = ""
```

In `.env` (and production secrets):
```ini
MY_PRODUCT_LICENSE_API_URL=https://my-product.example.com/api/v1/validate
```

### 1b. Implement the verifier

In `py-backend/app/services/license_verifier.py`, add a class:

```python
class MyProductLicenseVerifier(BaseLicenseVerifier):
    async def _verify(self, license_key: str, site_url: str) -> LicenseResult:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                self._settings.MY_PRODUCT_LICENSE_API_URL,
                json={"license_key": license_key, "site_url": site_url},
                timeout=10,
            )
        if r.status_code != 200:
            return LicenseResult(valid=False, user_id=None)
        data = r.json()
        return LicenseResult(valid=data.get("valid", False), user_id=data.get("user_id"))
```

### 1c. Register in the factory

In `LicenseVerifierFactory.get()`:
```python
"my-product": MyProductLicenseVerifier(settings),
```

---

## Part 2: Backend — agent and role

### 2a. Create a prompt snippet (recommended)

```bash
curl -X POST https://wap.example.com/admin/snippets \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "my_product_knowledge",
    "content": "Product knowledge base text goes here..."
  }'
```

### 2b. Create an agent

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
    "system_prompt": "You are an expert for My Product...\n\n{{snippet:my_product_knowledge}}",
    "temperature": 0.3,
    "max_turns": 25,
    "tools": [{"type": "mcp"}]
  }'
```

Note the `id` in the response.

### 2c. Map the role

```bash
curl -X PUT https://wap.example.com/admin/roles/my-product:standard \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "<id from above>"}'
```

---

## Part 3: WordPress client plugin

The `wap-client` library (`wp-client-plugin/wap-client/`) is a Composer package. Your product plugin depends on it.

### 3a. Add the dependency

In your product plugin's `composer.json`:
```json
{
  "require": {
    "group-one/wap-client": "^1.0"
  }
}
```

### 3b. Register the chat page

In your plugin's admin menu setup:
```php
use GroupOne\WapClient\ChatWidget;

add_action('admin_menu', function () {
    ChatWidget::register_chat_page([
        'menu_slug'   => 'my-plugin-wap-chat',
        'parent_slug' => 'my-plugin-settings',   // or wherever your menu lives
        'page_title'  => 'AI Assistant',
        'product'     => 'my-product',            // must match product_slug in agents DB
        'server_url'  => 'https://wap.group.one', // WAP backend URL
    ]);
});
```

### 3c. What the library does automatically

On every admin page load for this menu page:

1. Checks for a stored WP Application Password in user meta
2. If missing: provisions one via `POST /wp-json/wp/v2/users/{id}/application-passwords`
3. Calls `POST {server_url}/api/v1/auth/session` server-side (PHP curl) with:
   - `product`: the slug you provided
   - `license_key`: retrieved from your plugin's option
   - `site_url`: the current site URL
   - `wp_username` / `wp_app_password`: from step 2
   - `mcp_endpoint`: `{site_url}/wp-json/mcp/v1` (or overridable)
4. Stores the returned session token as a WordPress transient (per-user, 1h TTL)
5. Renders the chat widget with the token baked into the page

### 3d. Capability gating

The widget only renders for users with the `wap_use_ai` capability. The plugin activation hook grants this to `administrator` and `editor` roles. You can customize:

```php
// Grant to a specific user
$user = get_user_by('email', 'power-user@example.com');
$user->add_cap('wap_use_ai');

// Remove from editors if not appropriate for your product
$role = get_role('editor');
$role->remove_cap('wap_use_ai');
```

### 3e. White-labeling the chat widget

The chat widget uses CSS custom properties. Override them in your plugin's admin CSS:

```css
:root {
    --wap-bg-primary: #your-brand-color;
    --wap-button-bg: #your-cta-color;
    --wap-text-primary: #333;
    /* ... see wap-chat.css for full list */
}
```

---

## Checklist

- [ ] `MY_PRODUCT_LICENSE_API_URL` added to config and set in env
- [ ] `MyProductLicenseVerifier` implemented and registered in factory
- [ ] Prompt snippet created with product knowledge
- [ ] Agent created with `product_slug: "my-product"` and role mapped to `my-product:standard`
- [ ] `wap-client` Composer dependency added to product plugin
- [ ] `ChatWidget::register_chat_page()` called with correct `product` slug
- [ ] License key retrieval wired (plugin must pass its own license key to `ApiClient`)
- [ ] WordPress MCP Adapter plugin installed and active on client sites
- [ ] `ALLOWED_ORIGINS` updated to include product admin domains

---

## MCP Adapter requirement

Each WordPress site needs the **WordPress MCP Adapter** plugin installed and active for tool calls to work. Without it, the agent can still answer questions using its system prompt, but cannot read or modify site settings.

The MCP adapter plugin exposes WordPress functionality as MCP tools over HTTP. The WAP backend connects to it per-chat using the stored Application Password.
