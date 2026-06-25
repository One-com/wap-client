<?php
/**
 * Chat Widget — admin page registration and asset enqueueing.
 *
 * Registers the WordPress admin menu page for the WAP chat UI and handles
 * all PHP-side rendering, asset loading, and AJAX auth responses.
 *
 * @package GroupOne\WapClient
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

defined('ABSPATH') || exit;

/**
 * Manages the WAP chat admin page and its assets.
 *
 * Registered by WapClient::register_chat_page(). There can be multiple
 * chat pages registered by different plugins — each uses its own menu_slug
 * and product configuration.
 *
 * Static state (the $pages registry) is intentional: multiple plugins can
 * each call register_chat_page() and all their pages are rendered correctly.
 */
class ChatWidget
{
    /**
     * Registry of all registered chat pages.
     *
     * @var array<string, array>
     */
    private static array $pages = [];

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register a new WAP chat admin page.
     *
     * Called by WapClient::register_chat_page(). Hooks into admin_menu to add
     * the page and admin_enqueue_scripts to load assets.
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
     *     page_context?: string,
     * } $args Page configuration.
     *
     * @return void
     */
    public static function register(array $args): void
    {
        $menu_slug = sanitize_key($args['menu_slug'] ?? '');
        if (!$menu_slug) {
            _doing_it_wrong(
                'WapClient::register_chat_page',
                esc_html__('A non-empty menu_slug is required.', 'wap-client'),
                '1.0.0'
            );
            return;
        }

        // Normalise and store.
        self::$pages[$menu_slug] = [
            'menu_slug'          => $menu_slug,
            'parent_slug'        => $args['parent_slug'] ?? '',
            'page_title'         => $args['page_title'] ?? __('AI Assistant', 'wap-client'),
            'menu_title'         => $args['menu_title'] ?? __('AI Assistant', 'wap-client'),
            'product'            => sanitize_text_field($args['product'] ?? ''),
            'server_url'         => esc_url_raw($args['server_url'] ?? ''),
            'license_key'        => sanitize_text_field($args['license_key'] ?? ''),
            'mode'               => in_array($args['mode'] ?? 'product', ['product', 'orchestrator'], true)
                                        ? $args['mode']
                                        : 'product',
            'mcp_endpoint'       => esc_url_raw($args['mcp_endpoint'] ?? home_url('/wp-json/mcp/mcp-adapter-default-server')),
            'available_products' => array_map('sanitize_text_field', $args['available_products'] ?? []),
            'page_context'       => sanitize_key($args['page_context'] ?? ''),
        ];

        add_action('admin_menu', static function () use ($menu_slug): void {
            self::add_admin_menu($menu_slug);
        });

        add_action('admin_enqueue_scripts', static function (string $hook) use ($menu_slug): void {
            self::enqueue_assets($hook, $menu_slug);
        });
    }

    // -------------------------------------------------------------------------
    // Admin menu
    // -------------------------------------------------------------------------

    /**
     * Add the WordPress admin menu / sub-menu item for a registered page.
     *
     * @param string $menu_slug The menu slug for the page to add.
     *
     * @return void
     */
    private static function add_admin_menu(string $menu_slug): void
    {
        $page       = self::$pages[$menu_slug] ?? null;
        $capability = apply_filters('wap_client_capability', 'wap_use_ai');

        if (!$page || !current_user_can($capability)) {
            return;
        }

        $render_callback = static function () use ($menu_slug): void {
            self::render_page($menu_slug);
        };

        if (!empty($page['parent_slug'])) {
            add_submenu_page(
                $page['parent_slug'],
                esc_html($page['page_title']),
                esc_html($page['menu_title']),
                $capability,
                $menu_slug,
                $render_callback
            );
        } else {
            add_menu_page(
                esc_html($page['page_title']),
                esc_html($page['menu_title']),
                $capability,
                $menu_slug,
                $render_callback,
                'dashicons-format-chat',
                80
            );
        }
    }

    // -------------------------------------------------------------------------
    // Page rendering
    // -------------------------------------------------------------------------

    /**
     * Render the chat page HTML.
     *
     * Outputs the container markup for the JS widget. Capability is re-checked
     * here as a defence-in-depth measure.
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     *
     * @return void
     */
    private static function render_page(string $menu_slug): void
    {
        $capability = apply_filters('wap_client_capability', 'wap_use_ai');

        if (!current_user_can($capability)) {
            wp_die(esc_html__('You do not have permission to access this page.', 'wap-client'));
        }

        $page = self::$pages[$menu_slug] ?? null;
        if (!$page) {
            return;
        }

        ?>
        <div class="wrap wap-client-wrap">
            <h1><?php echo esc_html($page['page_title']); ?></h1>
            <div
                id="wap-chat-root"
                class="wap-chat-root"
                data-product="<?php echo esc_attr($page['product']); ?>"
            >
                <div class="wap-chat-loading" aria-live="polite">
                    <span class="wap-chat-loading__spinner" aria-hidden="true"></span>
                    <span><?php esc_html_e('Connecting to AI assistant…', 'wap-client'); ?></span>
                </div>
            </div>
        </div>
        <?php
    }

    // -------------------------------------------------------------------------
    // Asset enqueueing
    // -------------------------------------------------------------------------

    /**
     * Enqueue JS and CSS assets for the chat page.
     *
     * Only loads on the specific admin page to avoid polluting other screens.
     * Localises page-specific configuration to the JavaScript via wp_localize_script.
     *
     * @param string $hook      The current admin page hook suffix.
     * @param string $menu_slug The menu slug to check against.
     *
     * @return void
     */
    private static function enqueue_assets(string $hook, string $menu_slug): void
    {
        $page = self::$pages[$menu_slug] ?? null;
        if (!$page) {
            return;
        }

        // Only load on the specific page (hook contains the menu slug).
        if (false === strpos($hook, $menu_slug)) {
            return;
        }

        $capability = apply_filters('wap_client_capability', 'wap_use_ai');
        if (!current_user_can($capability)) {
            return;
        }

        $version = WAP_CLIENT_VERSION;
        $base_url = WAP_CLIENT_URL;

        wp_enqueue_style(
            'wap-client-chat-' . $menu_slug,
            $base_url . 'assets/wap-chat.css',
            [],
            $version
        );

        wp_enqueue_script(
            'wap-client-chat-' . $menu_slug,
            $base_url . 'assets/wap-chat.js',
            [], // No jQuery dependency — vanilla JS only.
            $version,
            true // Load in footer.
        );

        wp_localize_script(
            'wap-client-chat-' . $menu_slug,
            'WapClientConfig',
            [
                'ajaxUrl'         => admin_url('admin-ajax.php'),
                'authNonce'       => wp_create_nonce('wap_client_auth'),
                'deleteDataNonce' => wp_create_nonce('wap_client_delete_data'),
                'wapBrowserUrl'   => esc_url_raw($page['server_url']),
                'product'         => esc_js($page['product']),
                'mode'            => esc_js($page['mode']),
                'pageContext'     => esc_js($page['page_context']),
                'menuSlug'        => esc_js($menu_slug),
                'i18n'            => [
                    'placeholder'    => __('Ask the AI assistant…', 'wap-client'),
                    'send'           => __('Send', 'wap-client'),
                    'reconnecting'   => __('Reconnecting…', 'wap-client'),
                    'actionLabel'    => __('Action', 'wap-client'),
                    'showDetails'    => __('Show details', 'wap-client'),
                    'hideDetails'    => __('Hide details', 'wap-client'),
                    'deleteData'     => __('Delete my data', 'wap-client'),
                    'deleteConfirm'  => __('This will permanently delete all your conversation history with the AI assistant. This cannot be undone. Continue?', 'wap-client'),
                    'deleteSuccess'  => __('Your data has been deleted.', 'wap-client'),
                    'errorGeneric'   => __('An error occurred. Please try again.', 'wap-client'),
                    'errorRateLimit' => __('Too many requests. Please wait before sending another message.', 'wap-client'),
                ],
            ]
        );
    }

    // -------------------------------------------------------------------------
    // AJAX handler
    // -------------------------------------------------------------------------

    /**
     * AJAX handler: authenticate against WAP server.
     *
     * Runs server-side to avoid exposing App Passwords to the browser and to
     * sidestep CORS restrictions. Called when the JS widget needs a fresh token
     * (initial load or after a 401 response).
     *
     * @return void (sends JSON response and exits)
     */
    public static function ajax_auth(): void
    {
        check_ajax_referer('wap_client_auth');

        $capability = apply_filters('wap_client_capability', 'wap_use_ai');
        if (!current_user_can($capability)) {
            wp_send_json_error(['message' => __('Insufficient permissions.', 'wap-client')], 403);
        }

        // Sanitize input.
        $product    = sanitize_text_field(wp_unslash($_POST['product'] ?? ''));
        $menu_slug  = sanitize_key(wp_unslash($_POST['menu_slug'] ?? ''));
        $force_new  = !empty($_POST['force_new']); // Set to true when re-provisioning after 401.

        $page = self::$pages[$menu_slug] ?? null;
        if (!$page || !$product) {
            wp_send_json_error(['message' => __('Invalid request parameters.', 'wap-client')], 400);
        }

        $current_user = wp_get_current_user();
        if (!$current_user->exists()) {
            wp_send_json_error(['message' => __('User not authenticated.', 'wap-client')], 401);
        }

        // If forcing re-auth (after 401), revoke the stored App Password so a
        // fresh one is provisioned on the next auth call.
        if ($force_new) {
            $app_password_manager = new AppPasswordManager();
            $app_password_manager->delete_stored_password($current_user->ID, $product);
        }

        $result = \WapClient::get_session_token(
            $current_user->ID,
            $product,
            [
                'server_url'         => $page['server_url'],
                'product'            => $product,
                'product_label'      => $page['page_title'],
                'license_key'        => $page['license_key'],
                'site_url'           => home_url(),
                'mcp_endpoint'       => $page['mcp_endpoint'],
                'mode'               => $page['mode'],
                'available_products' => $page['available_products'] ?: [$product],
            ]
        );

        if (is_wp_error($result)) {
            $status = $result->get_error_code() === 'wap_license_invalid' ? 403 : 502;
            wp_send_json_error(['message' => $result->get_error_message()], $status);
        }

        wp_send_json_success([
            'token'          => $result['token'] ?? '',
            'conversationId' => $result['conversationId'] ?? '',
        ]);
    }


}
