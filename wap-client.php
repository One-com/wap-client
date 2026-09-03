<?php
/**
 * Plugin Name:       WAP Client
 * Plugin URI:        https://github.com/group-one/wap-client
 * Description:       WordPress AI Platform (WAP) client library. Integrates the WAP AI chat assistant into any WordPress plugin via a single static method call.
 * Version:           2.2.2
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
        'GroupOne\\WapClient\\AppPasswordManager'    => __DIR__ . '/includes/class-app-password-manager.php',
        'GroupOne\\WapClient\\ChatColumn'            => __DIR__ . '/includes/class-chat-column.php',
        'GroupOne\\WapClient\\ChatEmbed'             => __DIR__ . '/includes/class-chat-embed.php',
        'GroupOne\\WapClient\\ChatWidget'            => __DIR__ . '/includes/class-chat-widget.php',
        'GroupOne\\WapClient\\ScreenTarget'          => __DIR__ . '/includes/class-screen-target.php',
        'GroupOne\\WapClient\\GdprHandler'           => __DIR__ . '/includes/class-gdpr-handler.php',
        'GroupOne\\WapClient\\GrndService'           => __DIR__ . '/includes/class-grnd-service.php',
        'GroupOne\\WapClient\\GrndProviderInterface' => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\LicenseGrndProvider'   => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\CallableGrndProvider'  => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\TokenManager'          => __DIR__ . '/includes/class-token-manager.php',
        'GroupOne\\WapClient\\TokenSealer'           => __DIR__ . '/includes/class-token-sealer.php',
        'GroupOne\\WapClient\\WrapKeyClient'         => __DIR__ . '/includes/class-wrap-key-client.php',
    ];

    spl_autoload_register(static function (string $class) use ($class_map): void {
        if (isset($class_map[$class])) {
            require_once $class_map[$class];
        }
    });
}

use GroupOne\WapClient\ChatColumn;
use GroupOne\WapClient\ChatEmbed;
use GroupOne\WapClient\ChatWidget;
use GroupOne\WapClient\GdprHandler;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

define('WAP_CLIENT_VERSION', '2.2.0');
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

add_action('init', 'wap_client_load_textdomain');
add_action('plugins_loaded', 'wap_client_boot', 20);

/**
 * Load bundled translations for the `wap-client` text domain.
 *
 * Translation files live in the package-root `i18n/` directory as
 * `wap-client-{locale}.mo` and follow the active WordPress admin locale, so all
 * widget UI strings (labels, errors, disclaimers) are localised automatically.
 *
 * Loaded on `init` (not earlier) per WordPress 6.7+ just-in-time-translation
 * guidance.
 */
function wap_client_load_textdomain(): void {
    load_plugin_textdomain(
        'wap-client',
        false,
        dirname(plugin_basename(__FILE__)) . '/i18n'
    );
}

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

    // AJAX: T&C consent read/record (backs the widget's default consent hook).
    add_action('wp_ajax_wap_client_consent', ['GroupOne\\WapClient\\ChatWidget', 'ajax_consent']);

    // AJAX: docked-column state, persisted per user.
    add_action('wp_ajax_wap_client_column_state', ['GroupOne\\WapClient\\ChatColumn', 'ajax_state']);
}

// ---------------------------------------------------------------------------
// WapClient static facade
// ---------------------------------------------------------------------------

/**
 * WapClient — public integration API.
 *
 * Consuming plugins call WapClient::register_chat_page() from their admin
 * menu setup hook. Everything else (GRND acquisition + caching, App Password
 * provisioning, session management, widget rendering) is handled automatically.
 *
 * @package GroupOne\WapClient
 *
 * @example
 * // Minimal integration — call from the plugin's admin_menu callback.
 * // 'grnd' points at the brand's standardized exchange endpoint (same
 * // contract on every brand host — only the URL differs); the library
 * // handles caching, refresh, and passing the token to WAP. Brands with a
 * // non-standard backend pass a 'grnd_provider' callable instead.
 * WapClient::register_chat_page([
 *     'menu_slug'   => 'my-plugin-wap-chat',
 *     'parent_slug' => 'my-plugin-settings',
 *     'page_title'  => 'AI Assistant',
 *     'product'     => 'my-product-slug',
 *     'server_url'  => 'https://wap.group.one',
 *     'grnd'        => [
 *         'issuer_url'  => 'https://api.my-brand.com/grnd/token',
 *         'license_key' => get_option('my_product_license_key'),
 *     ],
 * ]);
 */
final class WapClient
{
    /**
     * Acquire a validated, cached GRND for a WordPress user.
     *
     * Single-call facade for consumers that need the GRND themselves (custom
     * admin pages, third-party plugins embedding the widget, exports, …).
     * Owns the full choreography — App Password provisioning, wrap-key fetch,
     * credential sealing, brand issuer exchange, caching, force_new refresh
     * — so no consumer reinvents it.
     *
     * @param array{
     *     product:         string,
     *     server_url:      string,
     *     issuer_url?:     string,
     *     license_key?:    string,
     *     grnd_provider?:  callable,
     *     user_id?:        int,
     *     user_login?:     string,
     *     force_new?:      bool,
     *     password_label?: string,
     *     extra_headers?:  array<string, string>,
     * } $args See {@see \GroupOne\WapClient\GrndService::get_grnd()}.
     *
     * @return string|\WP_Error The GRND on success; WP_Error with a named code
     *         on configuration / availability / sanity failures.
     *
     * @example
     *   // Echo of the test-client AJAX flow:
     *   $grnd = \WapClient::get_grnd_token([
     *       'product'    => 'wp-rocket',
     *       'server_url' => 'http://localhost:8010',
     *       'issuer_url' => 'https://api.brand.test/grnd/token',
     *   ]);
     *   if (is_wp_error($grnd)) { wp_send_json_error(['message' => 'unavailable'], 502); }
     *   wp_send_json_success(['token' => $grnd]);
     */
    public static function get_grnd_token(array $args)
    {
        return \GroupOne\WapClient\GrndService::get_grnd($args);
    }

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
     * Two options control how the page is presented, independently of each
     * other:
     *
     *   'hidden_admin_menu' => true         Register the page with no menu entry
     *                                       anywhere in wp-admin; it is reachable
     *                                       only at admin.php?page={menu_slug}.
     *                                       Takes precedence over 'parent_slug'.
     *   'render_mode'       => 'standalone' Output a bare HTML document with no
     *                                       wp-admin header, sidebar or footer,
     *                                       instead of a normal admin subpage.
     *                                       Defaults to 'admin'.
     *   'standalone_shell_css' => false     Skip the library's document-shell
     *                                       stylesheet so none of its body /
     *                                       box-sizing defaults reach a page
     *                                       the host styles itself. The host
     *                                       then owns the height chain too.
     *
     * Together they cover a first-run onboarding flow that should look like a
     * standalone wizard rather than a settings screen:
     *
     *   WapClient::register_chat_page([
     *       'menu_slug'         => 'my-plugin-onboarding',
     *       'page_title'        => 'Set up your site',
     *       'hidden_admin_menu' => true,
     *       'render_mode'       => 'standalone',
     *       'product'           => 'my-product-slug',
     *       'server_url'        => 'https://wap.group.one',
     *       'grnd'              => ['issuer_url' => '…', 'license_key' => '…'],
     *   ]);
     *
     * 'render' optionally hands the page body to a callable in either mode. It
     * receives a credential-free copy of the page config; call
     * ChatWidget::render_chat_root($menu_slug) inside it to place the widget:
     *
     *   'render' => function (array $page): void {
     *       echo '<header class="my-wizard-header">…</header>';
     *       \GroupOne\WapClient\ChatWidget::render_chat_root($page['menu_slug']);
     *   },
     *
     * @param array{
     *     menu_slug:    string,
     *     parent_slug?: string,
     *     page_title?:  string,
     *     menu_title?:  string,
     *     hidden_admin_menu?: bool,
     *     render_mode?: string,
     *     standalone_shell_css?: bool,
     *     render?:      callable,
     *     product:      string,
     *     server_url:   string,
     *     grnd?:        array{issuer_url?: string, license_key?: string},
     *     grnd_provider?: callable,
     *     mode?:        string,
     *     mcp_endpoint?: string,
     *     available_products?: string[],
     *     terms_url?:   string,
     *     privacy_url?: string,
     *     custom_css_url?: string,
     *     layout?:      array{width?: string, innerWidth?: string, align?: string,
     *                         expandToggle?: string, height?: string, chrome?: string,
     *                         accent?: string, keepScrollbar?: bool, showHeader?: bool,
     *                         showNewChat?: bool, showSettings?: bool, showDeleteData?: bool},
     * } $args Configuration array.
     *
     * @return void
     */
    public static function register_chat_page(array $args): void
    {
        // Registered unconditionally, even when Application Passwords are
        // unavailable (no HTTPS, or disabled by another plugin) — the page
        // itself is where that reason is explained via a contextual notice
        // in place of the widget, rather than the page silently disappearing.
        //
        // ChatWidget::register() queues an admin_menu hook that checks current_user_can()
        // at render time, so this method is safe to call at plugins_loaded before the
        // user session is authenticated.
        ChatWidget::register($args);
    }

    /**
     * Register the chat widget as a collapsible column docked onto admin screens
     * the host owns. Same credential keys as register_chat_page().
     *
     * Pass `screens` (hook suffixes / WP_Screen ids), a `should_render` callable,
     * or both. With neither, the column renders nowhere.
     *
     * ```php
     * WapClient::register_chat_column([
     *     'id'         => 'wp-rocket-assistant',
     *     'product'    => 'wp-rocket',
     *     'server_url' => 'https://wap.group.one',
     *     'grnd'       => ['issuer_url' => '…', 'license_key' => get_option('…')],
     *     'screens'    => ['toplevel_page_wprocket'],
     *     'column'     => ['side' => 'right', 'width' => '400px'],
     * ]);
     * ```
     *
     * A React/SPA admin mounts from JS instead — `WapChat.mount(el, opts)`, or a
     * `[data-wap-chat-column]` element. See docs/integrating-a-product.md.
     *
     * @param array{
     *     id:              string,
     *     product:         string,
     *     server_url:      string,
     *     screens?:        string[],
     *     should_render?:  callable,
     *     grnd?:           array{issuer_url?: string, license_key?: string},
     *     grnd_provider?:  callable,
     *     title?:          string,
     *     column?:         array{side?: string, width?: string, mode?: string,
     *                            defaultState?: string, breakpoint?: string,
     *                            showLauncher?: bool, persist?: bool},
     *     layout?:         array<string, mixed>,
     * } $args Configuration array.
     *
     * @return void
     */
    public static function register_chat_column(array $args): void
    {
        // Registered unconditionally — see register_chat_page() for why.
        ChatColumn::register($args);
    }

    /**
     * Register the chat widget as an inline embed — no admin page, no menu
     * entry, no panel chrome. Same credential keys as register_chat_page().
     *
     * Use this when the chat belongs *inside* a screen you already own: a tab on
     * your settings page, a metabox, a post-editor sidebar panel. The library
     * provides the credentials, the assets and the localised config; you decide
     * where the widget appears by calling {@see self::render_chatbox()} or
     * {@see self::get_chatbox()} from your own template.
     *
     * Call on `init` or `admin_init`, **not** `admin_menu` — the AJAX auth and
     * consent handlers resolve the surface from the live registry, and
     * `admin_menu` never fires on `admin-ajax.php`.
     *
     * Pass `screens` (hook suffixes / WP_Screen ids), a `should_render`
     * callable, or both, to say which screens load the assets. With neither, the
     * embed activates nowhere — fail-closed, as for a column.
     *
     * ```php
     * add_action('admin_init', function () {
     *     WapClient::register_chat_embed([
     *         'id'         => 'my-plugin-content-ai',
     *         'product'    => 'my-product',
     *         'server_url' => 'https://wap.group.one',
     *         'grnd'       => ['issuer_url' => '…', 'license_key' => get_option('…')],
     *         'screens'    => ['toplevel_page_my-plugin', 'post', 'page'],
     *         'layout'     => ['height' => '640px'],
     *     ]);
     * });
     *
     * // …then, inside your own tab body / metabox:
     * WapClient::render_chatbox('my-plugin-content-ai');
     * ```
     *
     * A React admin mounts from JS against the same registration —
     * `WapChat.mount(el, {column: false})` — so no PHP mount point is needed.
     * See docs/integrating-a-product.md.
     *
     * @param array{
     *     id:              string,
     *     product:         string,
     *     server_url:      string,
     *     screens?:        string[],
     *     should_render?:  callable,
     *     grnd?:           array{issuer_url?: string, license_key?: string},
     *     grnd_provider?:  callable,
     *     mode?:           string,
     *     mcp_endpoint?:   string,
     *     page_context?:   string,
     *     terms_url?:      string,
     *     privacy_url?:    string,
     *     custom_css_url?: string,
     *     title?:          string,
     *     layout?:         array<string, mixed>,
     * } $args Configuration array.
     *
     * @return void
     */
    public static function register_chat_embed(array $args): void
    {
        // Registered unconditionally — see register_chat_page() for why.
        ChatEmbed::register($args);
    }

    /**
     * Echo a registered embed's chatbox at this point in the markup.
     *
     * A no-op — no markup, no notice — when the embed is not registered, the
     * current screen was not opted in, or the user lacks the capability, so it
     * is safe to call unconditionally from a template.
     *
     * @param string $id The embed id passed to register_chat_embed().
     *
     * @return void
     */
    public static function render_chatbox(string $id): void
    {
        ChatEmbed::render($id);
    }

    /**
     * A registered embed's chatbox as an HTML string.
     *
     * For hosts that build markup rather than echo it. Returns '' in exactly the
     * cases where render_chatbox() emits nothing.
     *
     * @param string $id The embed id passed to register_chat_embed().
     *
     * @return string
     */
    public static function get_chatbox(string $id): string
    {
        return ChatEmbed::get($id);
    }

    /**
     * True when a registered embed will render on the current screen for the
     * current user.
     *
     * Use it to skip building your own chrome — a tab, a panel header, a
     * metabox — around a chatbox that is not going to appear.
     *
     * @param string $id The embed id passed to register_chat_embed().
     *
     * @return bool
     */
    public static function has_chatbox(string $id): bool
    {
        return ChatEmbed::is_active($id);
    }
}
