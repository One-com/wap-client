# WAP Client

WordPress AI Platform (WAP) client library — a drop-in Composer package for integrating an AI chat
assistant into any WordPress plugin via a single static method call.

The library is the **client ("doorway")** side only: it renders the chat widget in WordPress admin,
provisions a WordPress Application Password, and exchanges credentials with your WAP backend for a
session token. The AI itself runs on a separate backend service that you host.

## Requirements

- PHP >= 7.4
- WordPress >= 6.0
- HTTPS (required for WordPress Application Passwords)
- A running WAP backend (the `server_url` you point to)

## Installation

```bash
composer require groupone/wap-client
```

## Usage

Call from your plugin's `admin_menu` action:

```php
use WapClient; // global facade defined by the package..

add_action('admin_menu', function () {
    WapClient::register_chat_page([
        'menu_slug'   => 'my-plugin-wap-chat',
        'parent_slug' => 'my-plugin-settings',
        'page_title'  => 'AI Assistant',
        'product'     => 'my-product-slug',
        'server_url'  => 'https://your-wap-backend.example.com',
    ]);
});
```

The library handles capability gating, App Password provisioning, session management, and widget
rendering automatically.

## License

GPL-2.0-or-later
