<?php
/**
 * Plugin Name:       WAP Client
 * Plugin URI:        https://github.com/group-one/wap-client
 * Description:       WordPress AI Platform (WAP) client library. Integrates the WAP AI chat assistant into any WordPress plugin via a single static method call.
 * Version:           1.0.1
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Group.one
 * Author URI:        https://www.group.one
 * License:           GPL-2.0-or-later
 * License URI:       https://spdx.org/licenses/GPL-2.0-or-later.html
 * Text Domain:       wap-client
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

// ---------------------------------------------------------------------------
// Autoloader — PSR-4 via Composer, or manual fallback for non-Composer installs.
// ---------------------------------------------------------------------------

if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    require_once __DIR__ . '/vendor/autoload.php';
} else {
    // Manual class map fallback when Composer is not available.
    $class_map = [
        'GroupOne\\WapClient\\AppPasswordManager' => __DIR__ . '/includes/class-app-password-manager.php',
        'GroupOne\\WapClient\\ApiClient'          => __DIR__ . '/includes/class-api-client.php',
        'GroupOne\\WapClient\\ChatWidget'         => __DIR__ . '/includes/class-chat-widget.php',
        'GroupOne\\WapClient\\GdprHandler'        => __DIR__ . '/includes/class-gdpr-handler.php',
    ];

    spl_autoload_register(static function (string $class) use ($class_map): void {
        if (isset($class_map[$class])) {
            require_once $class_map[$class];
        }
    });
}

use GroupOne\WapClient\AppPasswordManager;
use GroupOne\WapClient\ChatWidget;
use GroupOne\WapClient\GdprHandler;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

define('WAP_CLIENT_VERSION', '1.0.0');
define('WAP_CLIENT_DIR', plugin_dir_path(__FILE__));
define('WAP_CLIENT_URL', plugin_dir_url(__FILE__));

// ---------------------------------------------------------------------------
// Activation / deactivation hooks
// ---------------------------------------------------------------------------

register_activation_hook(__FILE__, 'wap_client_activate');
register_deactivation_hook(__FILE__, 'wap_client_deactivate');

/**
 * On activation: grant the wap_use_ai capability to administrator and editor roles.
 *
 * Uses the filter `wap_client_capability` in case the capability name is overridden.
 */
function wap_client_activate(): void {
    $capability = apply_filters('wap_client_capability', 'wap_use_ai');
    $roles      = ['administrator', 'editor'];

    foreach ($roles as $role_name) {
        $role = get_role($role_name);
        if ($role instanceof \WP_Role) {
            $role->add_cap($capability);
        }
    }
}

/**
 * On deactivation: optionally remove the capability.
 *
 * We leave it in place so that re-activating the plugin does not change
 * any admin-configured capability grants.
 */
function wap_client_deactivate(): void {
    // Intentionally a no-op. Capability grants are preserved across deactivation
    // so that site administrators can manage them independently.
}

// ---------------------------------------------------------------------------
// Boot hooks
// ---------------------------------------------------------------------------

add_action('plugins_loaded', 'wap_client_boot', 20);

/**
 * Boot the WAP client after all plugins have loaded.
 *
 * Registers AJAX handlers and the GDPR erasure handler.
 */
function wap_client_boot(): void {
    // AJAX: server-side auth call to WAP (avoids browser CORS restrictions).
    add_action('wp_ajax_wap_client_auth', ['GroupOne\\WapClient\\ChatWidget', 'ajax_auth']);

    // AJAX: GDPR erasure — proxies DELETE /api/v1/me/data to WAP.
    add_action('wp_ajax_wap_client_delete_data', ['GroupOne\\WapClient\\GdprHandler', 'ajax_delete_data']);

    // Admin notice when Application Passwords are unavailable (non-HTTPS).
    add_action('admin_notices', 'wap_client_maybe_show_https_notice');
}

/**
 * Show an admin notice when WordPress Application Passwords are disabled.
 *
 * Application Passwords require HTTPS. On non-HTTPS sites WordPress disables
 * them entirely. We surface a clear, non-blocking notice explaining this.
 */
function wap_client_maybe_show_https_notice(): void {
    if (!AppPasswordManager::are_app_passwords_available()) {
        $message = sprintf(
            /* translators: 1: documentation URL */
            __('<strong>WAP AI Assistant</strong> requires HTTPS to use WordPress Application Passwords. The AI chat widget will be hidden until this site is served over HTTPS. <a href="%s" target="_blank" rel="noopener noreferrer">Learn more</a>.', 'wap-client'),
            'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/'
        );
        printf('<div class="notice notice-warning"><p>%s</p></div>', wp_kses_post($message));
    }
}

// ---------------------------------------------------------------------------
// WapClient static facade
// ---------------------------------------------------------------------------

/**
 * WapClient — public integration API.
 *
 * Consuming plugins call WapClient::register_chat_page() from their admin
 * menu setup hook. Everything else (App Password provisioning, session
 * management, widget rendering) is handled automatically.
 *
 * @package GroupOne\WapClient
 *
 * @example
 * // Minimal integration — call from the plugin's admin_menu callback:
 * WapClient::register_chat_page([
 *     'menu_slug'   => 'my-plugin-wap-chat',
 *     'parent_slug' => 'my-plugin-settings',
 *     'page_title'  => 'AI Assistant',
 *     'product'     => 'my-product-slug',
 *     'server_url'  => 'https://wap.group.one',
 * ]);
 */
final class WapClient
{
    /**
     * Private constructor — this class is a static facade only.
     */
    private function __construct()
    {
    }

    /**
     * Register a WAP chat admin page.
     *
     * Call this from your plugin's `admin_menu` action. The library handles
     * capability gating, App Password provisioning, session management, and
     * widget rendering automatically.
     *
     * @param array{
     *     menu_slug:    string,
     *     parent_slug?: string,
     *     page_title?:  string,
     *     menu_title?:  string,
     *     product:      string,
     *     server_url:   string,
     *     license_key?: string,
     *     mode?:        string,
     *     mcp_endpoint?: string,
     *     available_products?: string[],
     * } $args Configuration array.
     *
     * @return void
     */
    public static function register_chat_page(array $args): void
    {
        // Application Passwords must be available (requires HTTPS or WAP_CLIENT_DEV_MODE).
        // Do not register on non-HTTPS sites — the AJAX auth flow will fail anyway.
        if (!AppPasswordManager::are_app_passwords_available()) {
            return;
        }

        // ChatWidget::register() queues an admin_menu hook that checks current_user_can()
        // at render time, so this method is safe to call at plugins_loaded before the
        // user session is authenticated.
        ChatWidget::register($args);
    }

    /**
     * Return the WAP session data for a user/product combination, provisioning
     * a new App Password and backend session on every call.
     *
     * Returns the full backend response array (including 'token' and
     * 'conversationId') so callers can use the server-authoritative
     * conversationId rather than computing it locally.
     *
     * @param int    $wp_user_id WordPress user ID.
     * @param string $product    Product slug (e.g. 'wp-rocket').
     * @param array  $auth_args  Arguments for the WAP auth call.
     *
     * @return array|WP_Error Backend session data array or WP_Error on failure.
     */
    public static function get_session_token(int $wp_user_id, string $product, array $auth_args)
    {
        $app_password_manager = new AppPasswordManager();

        // Provision a fresh App Password (revokes the previous one automatically).
        $app_password = $app_password_manager->provision($wp_user_id, $product, $auth_args['product_label'] ?? $product);
        if (is_wp_error($app_password)) {
            return $app_password;
        }

        // Obtain a fresh WAP session from the backend on every page load.
        $api_client = new \GroupOne\WapClient\ApiClient($auth_args['server_url']);
        $result     = $api_client->create_session(array_merge($auth_args, [
            'wp_username'     => wp_get_current_user()->user_login,
            'wp_app_password' => $app_password,
        ]));

        if (is_wp_error($result)) {
            return $result;
        }

        return $result;
    }
}
