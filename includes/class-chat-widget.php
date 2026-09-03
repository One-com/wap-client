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

    /**
     * Slug of the surface that took the current admin screen, or '' while none
     * has. One screen carries at most one widget: the JS keeps module-level
     * state and a single frozen WapClientConfig, so a second surface would
     * re-initialise the first rather than run beside it.
     *
     * @var string
     */
    private static string $screen_owner = '';

    /**
     * Presentation defaults applied when render_mode is 'standalone'.
     * Caller-supplied layout keys always win over these.
     *
     * @var array<string, string>
     */
    private const STANDALONE_LAYOUT = [
        'width'        => 'fluid',
        'height'       => 'fill',
        'chrome'       => 'flat',
        'expandToggle' => 'off',
    ];

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register a new WAP chat admin page.
     *
     * Called by WapClient::register_chat_page(). Hooks into admin_menu to add
     * the page and admin_enqueue_scripts to load assets.
     *
     * Entitlement is proven by a GRND obtained server-side at auth time.
     * Configure ONE of:
     *   'grnd'          => ['issuer_url' => ..., 'license_key' => ...] for the
     *                      standardized brand exchange (same contract on every
     *                      brand host — only the URL differs), or
     *   'grnd_provider' => callable returning the raw GRND string (or an array
     *                      with 'grnd'/'expires_at', or a WP_Error) for brands
     *                      with a non-standard backend.
     *
     * Presentation is controlled by two independent options:
     *   'hidden_admin_menu' => true       Register the page without any menu
     *                                     entry — reachable only by direct URL
     *                                     (admin.php?page={menu_slug}). Takes
     *                                     precedence over 'parent_slug'.
     *   'render_mode'       => 'standalone' Emit a bare HTML document with no
     *                                     wp-admin header, sidebar or footer,
     *                                     instead of a normal admin subpage.
     *                                     Defaults to 'admin'.
     *   'standalone_shell_css' => false   Skip assets/wap-standalone.css so a
     *                                     host that styles the document itself
     *                                     keeps its own body/box-sizing rules.
     *                                     Ignored in 'admin' mode.
     *
     * 'render' optionally hands the page body to the caller in either mode; use
     * {@see self::render_chat_root()} inside it to place the widget container.
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
     *     page_context?: string,
     *     terms_url?:   string,
     *     privacy_url?: string,
     *     custom_css_url?: string,
     *     layout?:      array{width?: string, innerWidth?: string, align?: string,
     *                         expandToggle?: string, height?: string, chrome?: string,
     *                         accent?: string, keepScrollbar?: bool, showHeader?: bool,
     *                         showNewChat?: bool, showSettings?: bool, showDeleteData?: bool},
     * } $args Page configuration.
     *
     * @return void
     */
    public static function register(array $args): void
    {
        $menu_slug = self::register_surface($args, 'WapClient::register_chat_page');
        if (null === $menu_slug) {
            return;
        }

        add_action('admin_menu', static function () use ($menu_slug): void {
            self::add_admin_menu($menu_slug);
        });

        add_action('admin_enqueue_scripts', static function (string $hook) use ($menu_slug): void {
            self::enqueue_assets($hook, $menu_slug);
        });
    }

    /**
     * Normalise a widget surface's configuration and store it in the registry,
     * without wiring any admin menu or asset hooks. The caller owns when and
     * where assets are enqueued. Used by ChatColumn.
     *
     * @param array  $args    Surface configuration; see {@see self::register()}.
     * @param string $context Caller name used in the _doing_it_wrong() notice.
     * @param string $kind    'page', 'column' or 'embed' — which surface type
     *                        this record is. Drives screen-ownership decisions.
     * @param array<string, string|bool> $layout_defaults Presentation defaults
     *                        for this surface type. Applied *after* the caller's
     *                        layout is sanitised, so an invalid caller value
     *                        falls back to the default rather than to nothing.
     *
     * @return string|null The sanitised slug, or null when the slug is unusable.
     */
    public static function register_surface(
        array $args,
        string $context = 'WapClient::register_chat_page',
        string $kind = 'page',
        array $layout_defaults = []
    ): ?string {
        $menu_slug = sanitize_key($args['menu_slug'] ?? '');
        if (!$menu_slug) {
            _doing_it_wrong(
                $context,
                esc_html__('A non-empty menu_slug is required.', 'wap-client'),
                '1.0.0'
            );
            return null;
        }

        $render_mode = $args['render_mode'] ?? 'admin';
        if (!in_array($render_mode, ['admin', 'standalone'], true)) {
            $render_mode = 'admin';
        }

        $standalone_css = !isset($args['standalone_shell_css']) || (bool) $args['standalone_shell_css'];

        $layout = self::sanitize_layout($args['layout'] ?? []);
        $layout += $layout_defaults;
        if ('standalone' === $render_mode) {
            $layout += self::STANDALONE_LAYOUT;
        }

        // Normalise and store.
        self::$pages[$menu_slug] = [
            'kind'               => in_array($kind, ['page', 'column', 'embed'], true) ? $kind : 'page',
            'menu_slug'          => $menu_slug,
            'parent_slug'        => $args['parent_slug'] ?? '',
            'page_title'         => $args['page_title'] ?? __('AI Agent', 'wap-client'),
            'menu_title'         => $args['menu_title'] ?? __('AI Agent', 'wap-client'),
            'hidden_admin_menu'  => !empty($args['hidden_admin_menu']),
            'render_mode'        => $render_mode,
            'standalone_css'     => $standalone_css,
            'render'             => is_callable($args['render'] ?? null) ? $args['render'] : null,
            'hook_suffix'        => '',
            // Non-default mount-point id, surfaced to the widget as cfg.root so
            // it does not fall back to looking up #wap-chat-root. Empty for a
            // page (which uses the default id) and for a column (which the
            // widget finds through its [data-wap-chat-column] wrapper).
            'root_id'            => sanitize_html_class($args['root_id'] ?? ''),
            'product'            => sanitize_text_field($args['product'] ?? ''),
            'server_url'         => esc_url_raw($args['server_url'] ?? ''),
            'grnd_issuer_url'    => esc_url_raw($args['grnd']['issuer_url'] ?? ''),
            'grnd_license_key'   => sanitize_text_field($args['grnd']['license_key'] ?? ''),
            'grnd_provider'      => is_callable($args['grnd_provider'] ?? null) ? $args['grnd_provider'] : null,
            'mode'               => in_array($args['mode'] ?? 'product', ['product', 'orchestrator'], true)
                                        ? ($args['mode'] ?? 'product')
                                        : 'product',
            'mcp_endpoint'       => esc_url_raw($args['mcp_endpoint'] ?? home_url('/wp-json/mcp/mcp-adapter-default-server')),
            'available_products' => array_map('sanitize_text_field', $args['available_products'] ?? []),
            'page_context'       => sanitize_key($args['page_context'] ?? ''),
            'terms_url'          => esc_url_raw($args['terms_url'] ?? ''),
            'privacy_url'        => esc_url_raw($args['privacy_url'] ?? ''),
            // Optional per-tenant brand stylesheet, injected client-side as the
            // last <link> so its rules layer on top of ours (see the widget's
            // injectCustomCss()). Sites can also set it via the
            // `wap_client_custom_css_url` filter without editing this call.
            'custom_css_url'     => esc_url_raw($args['custom_css_url'] ?? ''),
            // Optional presentation layout → widget cfg.layout (sanitised).
            'layout'             => $layout,
            // Empty for a menu page; ChatColumn::register() populates it.
            'column'             => self::sanitize_column($args['column'] ?? []),
        ];

        return $menu_slug;
    }

    // -------------------------------------------------------------------------
    // Admin menu
    // -------------------------------------------------------------------------

    /**
     * Add the WordPress admin menu / sub-menu item for a registered page.
     *
     * hidden_admin_menu registers with an empty parent slug, which WordPress
     * treats as "valid page, no menu entry"; parent_slug nests under that
     * parent; neither yields a top-level item. The render callback is wired in
     * every case, including standalone mode where it is never reached — a page
     * hook with no action attached is not dispatchable by admin.php.
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

        if (!empty($page['hidden_admin_menu'])) {
            $hook_suffix = add_submenu_page(
                '',
                esc_html($page['page_title']),
                esc_html($page['menu_title']),
                $capability,
                $menu_slug,
                $render_callback
            );
        } elseif (!empty($page['parent_slug'])) {
            $hook_suffix = add_submenu_page(
                $page['parent_slug'],
                esc_html($page['page_title']),
                esc_html($page['menu_title']),
                $capability,
                $menu_slug,
                $render_callback
            );
        } else {
            $hook_suffix = add_menu_page(
                esc_html($page['page_title']),
                esc_html($page['menu_title']),
                $capability,
                $menu_slug,
                $render_callback,
                'dashicons-format-chat',
                80
            );
        }

        if (!is_string($hook_suffix) || '' === $hook_suffix) {
            return;
        }

        self::$pages[$menu_slug]['hook_suffix'] = $hook_suffix;

        if ('standalone' !== $page['render_mode']) {
            return;
        }

        add_action('load-' . $hook_suffix, static function () use ($menu_slug): void {
            self::render_standalone_page($menu_slug);
        });
    }

    // -------------------------------------------------------------------------
    // Page rendering
    // -------------------------------------------------------------------------

    /**
     * Render the chat page inside the normal wp-admin chrome.
     *
     * Capability is re-checked here as a defence-in-depth measure. In standalone
     * mode this callback is registered but never reached — see add_admin_menu().
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     *
     * @return void
     */
    private static function render_page(string $menu_slug): void
    {
        $page = self::require_page_access($menu_slug);
        if (!$page) {
            return;
        }

        ?>
        <div class="wrap wap-client-wrap gv-activated">
            <?php if (!$page['render'] && !empty($page['page_title'])) : ?>
                <h1><?php echo esc_html($page['page_title']); ?></h1>
            <?php endif; ?>
            <?php self::render_body($page); ?>
        </div>
        <?php
    }

    /**
     * Render the chat page as a standalone HTML document.
     *
     * Runs on load-{$hook_suffix} and exits, so admin.php never reaches
     * admin-header.php / admin-footer.php — no wp-admin chrome and no core
     * admin stylesheets. The asset and head hooks those files would have fired
     * are reproduced in output_standalone_document().
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     *
     * @return void
     */
    private static function render_standalone_page(string $menu_slug): void
    {
        $page = self::require_page_access($menu_slug);
        if (!$page) {
            return;
        }

        nocache_headers();
        self::output_standalone_document($page);
        exit;
    }

    /**
     * Emit the standalone document for a page.
     *
     * Split from render_standalone_page() so the document can be produced
     * without terminating the request.
     *
     * @param array $page Normalised page record.
     *
     * @return void
     */
    private static function output_standalone_document(array $page): void
    {
        $hook_suffix = (string) $page['hook_suffix'];
        $body_class  = implode(' ', self::standalone_body_classes($page['menu_slug']));
        $title       = '' !== $page['page_title'] ? $page['page_title'] : $page['menu_title'];

        echo '<!DOCTYPE html>' . "\n";
        ?>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php echo esc_attr(get_bloginfo('charset')); ?>" />
    <meta name="robots" content="noindex, nofollow" />
    <title><?php echo esc_html($title); ?></title>
    <?php
    if (!has_action('admin_head', 'wp_admin_viewport_meta')) {
        $viewport = (string) apply_filters('admin_viewport_meta', 'width=device-width, initial-scale=1.0');
        if ('' !== $viewport) {
            echo '<meta name="viewport" content="' . esc_attr($viewport) . '" />' . "\n";
        }
    }

    do_action('admin_enqueue_scripts', $hook_suffix);
    do_action("admin_print_styles-{$hook_suffix}"); // phpcs:ignore WordPress.NamingConventions.ValidHookName
    do_action('admin_print_styles');
    do_action("admin_print_scripts-{$hook_suffix}"); // phpcs:ignore WordPress.NamingConventions.ValidHookName
    do_action('admin_print_scripts');
    do_action("admin_head-{$hook_suffix}"); // phpcs:ignore WordPress.NamingConventions.ValidHookName
    do_action('admin_head');
    ?>
</head>
<body class="<?php echo esc_attr($body_class); ?>">
    <div class="wap-standalone-shell gv-activated">
        <?php self::render_body($page); ?>
    </div>
    <?php
    do_action("admin_print_footer_scripts-{$hook_suffix}"); // phpcs:ignore WordPress.NamingConventions.ValidHookName
    do_action('admin_print_footer_scripts');
    do_action("admin_footer-{$hook_suffix}"); // phpcs:ignore WordPress.NamingConventions.ValidHookName
    ?>
</body>
</html>
        <?php
    }

    /**
     * Output the page body: the caller's render callback when one was given,
     * otherwise the widget container on its own.
     *
     * @param array $page Normalised page record.
     *
     * @return void
     */
    private static function render_body(array $page): void
    {
        if ($page['render']) {
            call_user_func($page['render'], self::public_page_config($page));
            return;
        }

        self::render_chat_root($page['menu_slug']);
    }

    /**
     * Output the widget mount point for a registered page.
     *
     * Public so a 'render' callback can position the widget inside its own
     * markup; the JS widget looks this element up by id and attaches its
     * classes to it.
     *
     * $root_id defaults to the historical `wap-chat-root`. A second surface on
     * the same screen MUST pass its own id.
     *
     * When Application Passwords are unavailable, this renders a contextual
     * notice instead of the mount point — scoped to this surface only, rather
     * than a global admin_notices banner every screen would show.
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     * @param string $root_id   DOM id for the mount point.
     *
     * @return void
     */
    public static function render_chat_root(string $menu_slug, string $root_id = 'wap-chat-root'): void
    {
        $page = self::$pages[$menu_slug] ?? null;
        if (!$page) {
            return;
        }

        if (!AppPasswordManager::are_app_passwords_available()) {
            self::render_unavailable_notice();
            return;
        }

        $root_id = sanitize_html_class($root_id) ?: 'wap-chat-root';

        ?>
        <div
            id="<?php echo esc_attr($root_id); ?>"
            class="wap-chat-root"
            data-product="<?php echo esc_attr($page['product']); ?>"
        >
            <div class="gv-loader-container" aria-live="polite">
                <gv-loader src="https://gravity.group-cdn.one/v5.40.0/loaders/spinner.svg"></gv-loader>
                <p><?php esc_html_e('Connecting to AI assistant…', 'wap-client'); ?></p>
            </div>
        </div>
        <?php
    }

    /**
     * Render the Application-Passwords-unavailable notice in place of the
     * widget mount point.
     *
     * Distinguishes the two causes so the message names the actual one: HTTPS
     * not being enabled, versus Application Passwords having been disabled
     * outright (e.g. by a security plugin) via the filterable
     * `wp_is_application_passwords_available` — which is independent of SSL.
     *
     * @return void
     */
    private static function render_unavailable_notice(): void
    {
        if (AppPasswordManager::is_https_missing()) {
            $message = sprintf(
                /* translators: 1: documentation URL */
                __('This AI assistant requires HTTPS to use WordPress Application Passwords. It will be available once this site is served over HTTPS. <a href="%s" target="_blank" rel="noopener noreferrer">Learn more</a>.', 'wap-client'),
                'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/'
            );
        } else {
            $message = __('This AI assistant is unavailable because WordPress Application Passwords have been disabled on this site. Enable Application Passwords to use the AI Assistant.', 'wap-client');
        }

        printf('<div class="notice notice-warning inline wap-client-unavailable-notice"><p>%s</p></div>', wp_kses_post($message));
    }

    /**
     * True when the given admin hook suffix belongs to a registered chat page.
     * Consulted by ChatColumn, which stands down in that case.
     *
     * Matched exactly, or against WordPress's own `<parent>_page_<slug>` hook
     * shape. Deliberately NOT the substring test enqueue_assets() uses: this
     * drives a stand-down decision, so a broad slug would silently suppress the
     * column on every unrelated screen whose hook contains it.
     *
     * @param string $hook The current admin page hook suffix.
     *
     * @return bool
     */
    public static function hook_belongs_to_page(string $hook): bool
    {
        if ('' === $hook) {
            return false;
        }

        foreach (self::$pages as $slug => $page) {
            if ('page' !== ($page['kind'] ?? 'page') || '' === $slug) {
                continue;
            }
            if ($hook === $slug || self::str_ends_with($hook, '_page_' . $slug)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Claim the current admin screen for a surface.
     *
     * Only the screen-mounted surfaces (embeds and columns) claim: a chat page
     * owns its screen by definition, and both of them already defer to it
     * through hook_belongs_to_page(). That test is exact, whereas the page's own
     * asset gate matches the slug as a substring — too loose to decide a
     * stand-down, since a page slugged 'chat' would otherwise suppress every
     * surface on an unrelated 'toplevel_page_my-chat-plugin' screen.
     *
     * Between the two claimants, precedence is decided by hook priority rather
     * than by who registered first: an embed activates on admin_enqueue_scripts
     * priority 5, a column on priority 10. First claim wins.
     *
     * @param string $menu_slug The registered surface slug.
     *
     * @return bool True when the surface took the screen, false when it was
     *              already taken by another one.
     */
    public static function claim_screen(string $menu_slug): bool
    {
        if ('' !== self::$screen_owner) {
            return self::$screen_owner === $menu_slug;
        }

        self::$screen_owner = $menu_slug;

        return true;
    }

    /**
     * str_ends_with() polyfill — the package supports PHP 7.4.
     *
     * @param string $haystack Subject.
     * @param string $needle   Suffix to test.
     *
     * @return bool
     */
    private static function str_ends_with(string $haystack, string $needle): bool
    {
        if ('' === $needle) {
            return true;
        }

        return substr($haystack, -strlen($needle)) === $needle;
    }

    /**
     * The sanitised column config of a registered surface.
     *
     * @param string $menu_slug The registered surface slug.
     *
     * @return array<string, string|bool> Empty when the surface is not a column.
     */
    public static function surface_column_config(string $menu_slug): array
    {
        return self::$pages[$menu_slug]['column'] ?? [];
    }

    /**
     * The column config as the widget receives it: filtered, re-sanitised, plus
     * the id and the state-endpoint nonce.
     *
     * Both are added AFTER sanitize_column(), which drops unknown keys by design
     * — that is what makes the wap_client_column filter safe. Passing them
     * through cfg.column keeps the JS↔PHP contract explicit rather than having
     * the widget rebuild a global's name from PHP's id mangling.
     *
     * @param string $menu_slug The registered surface slug (also the column id).
     * @param array  $page      The registered surface record.
     *
     * @return array<string, string|bool> Sanitised column map.
     */
    private static function column_config(string $menu_slug, array $page): array
    {
        $column = self::sanitize_column(apply_filters(
            'wap_client_column',
            $page['column'],
            $page['product']
        ));

        $column['id']         = $menu_slug;
        $column['stateNonce'] = wp_create_nonce('wap_client_column_state');

        return $column;
    }

    /**
     * Look up a registered page and enforce the capability gate.
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     *
     * @return array|null The page record, or null when it is not registered.
     */
    private static function require_page_access(string $menu_slug): ?array
    {
        $capability = apply_filters('wap_client_capability', 'wap_use_ai');

        if (!current_user_can($capability)) {
            wp_die(esc_html__('You do not have permission to access this page.', 'wap-client'));
        }

        return self::$pages[$menu_slug] ?? null;
    }

    /**
     * Body classes for a standalone page.
     *
     * @param string $menu_slug The menu slug identifying which page to render.
     *
     * @return string[] Sanitised, non-empty class names.
     */
    private static function standalone_body_classes(string $menu_slug): array
    {
        $classes = apply_filters(
            'wap_client_standalone_body_class',
            ['wap-standalone', 'wap-standalone-' . $menu_slug],
            $menu_slug
        );

        if (!is_array($classes)) {
            return ['wap-standalone'];
        }

        $classes = array_filter($classes, 'is_scalar');
        $classes = array_filter(array_map('sanitize_html_class', array_map('strval', $classes)));

        return $classes ?: ['wap-standalone'];
    }

    /**
     * The subset of a page record that is safe to hand to a render callback.
     * Credentials and endpoints stay internal — a presentation callback has no
     * use for them.
     *
     * @param array $page Normalised page record.
     *
     * @return array<string, string|bool>
     */
    private static function public_page_config(array $page): array
    {
        return [
            'menu_slug'         => $page['menu_slug'],
            'page_title'        => $page['page_title'],
            'menu_title'        => $page['menu_title'],
            'product'           => $page['product'],
            'mode'              => $page['mode'],
            'render_mode'       => $page['render_mode'],
            'hidden_admin_menu' => $page['hidden_admin_menu'],
        ];
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
        // Only load on the specific page (hook contains the menu slug).
        if (false === strpos($hook, $menu_slug)) {
            return;
        }

        self::enqueue_widget_assets($menu_slug);
    }

    /**
     * Enqueue the Gravity design system, the widget stylesheet/script, and the
     * localised config for a registered surface. Screen-agnostic; the page path
     * reaches it through enqueue_assets(), which owns the hook-suffix match.
     *
     * @param string $menu_slug The registered surface slug.
     *
     * @return void
     */
    public static function enqueue_widget_assets(string $menu_slug): void
    {
        $page = self::$pages[$menu_slug] ?? null;
        if (!$page) {
            return;
        }

        $capability = apply_filters('wap_client_capability', 'wap_use_ai');
        if (!current_user_can($capability)) {
            return;
        }

        $version = WAP_CLIENT_VERSION;
        $base_url = WAP_CLIENT_URL;

        wp_enqueue_style(
            'gravity-design-system',
            'https://gravity.group-cdn.one/v5.40.0/css/brands/group-one.min.css',
            [],
            null
        );

        wp_enqueue_script(
            'gravity-design-system-js',
            'https://gravity.group-cdn.one/v5.40.0/index.umd.js',
            [],
            null,
            true
        );

        wp_enqueue_style(
            'wap-client-chat-' . $menu_slug,
            $base_url . 'assets/wap-chat.css',
            [ 'gravity-design-system' ],
            $version
        );

        $shell_css = 'standalone' === $page['render_mode'] && apply_filters(
            'wap_client_standalone_shell_css',
            $page['standalone_css'],
            $menu_slug
        );

        if ($shell_css) {
            wp_enqueue_style(
                'wap-client-standalone-' . $menu_slug,
                $base_url . 'assets/wap-standalone.css',
                [ 'wap-client-chat-' . $menu_slug ],
                $version
            );
        }

        // Optional Mixpanel analytics (client-side). Off unless a token is
        // supplied via the wap_client_mixpanel_token filter. Both the SDK and its
        // loader snippet are vendored — WordPress.org guidelines forbid loading
        // third-party scripts from a CDN.
        //
        // We enqueue the LOADER, not the library: the library is the
        // snippet-companion build and requires the window.mixpanel stub the
        // loader creates (standalone it errors with '"mixpanel" object not
        // initialized'). The loader injects the library itself, from the URL in
        // MIXPANEL_CUSTOM_LIB_URL — Mixpanel's supported self-hosting hook. The
        // stub queues our init/register/track calls until the library lands, so
        // the widget can start tracking immediately.
        $mixpanel_token      = (string) apply_filters('wap_client_mixpanel_token', '');
        $mixpanel_lib_url    = '';
        $mixpanel_loader_url = '';
        $widget_deps         = []; // No jQuery dependency — vanilla JS only.
        if ('' !== $mixpanel_token) {
            $mixpanel_lib_url    = $base_url . 'assets/vendor/mixpanel.min.js';
            $mixpanel_loader_url = $base_url . 'assets/vendor/mixpanel-loader.js';
            wp_enqueue_script(
                'wap-client-mixpanel',
                $mixpanel_loader_url,
                [],
                '2.80.0', // vendored Mixpanel Web SDK version
                true
            );
            // Must precede the loader: it reads this global to locate the library.
            wp_add_inline_script(
                'wap-client-mixpanel',
                'window.MIXPANEL_CUSTOM_LIB_URL = ' . wp_json_encode($mixpanel_lib_url) . ';',
                'before'
            );
            $widget_deps[] = 'wap-client-mixpanel';
        }

        wp_enqueue_script(
            'wap-client-chat-' . $menu_slug,
            $base_url . 'assets/wap-chat.js',
            $widget_deps,
            $version,
            true // Load in footer.
        );

        wp_localize_script(
            'wap-client-chat-' . $menu_slug,
            'WapClientConfig',
            [
                'ajaxUrl'         => admin_url('admin-ajax.php'),
                // Selector for a namespaced mount point; '' lets the widget use
                // its own default resolution (#wap-chat-root, then the column
                // mount point).
                'root'            => '' !== $page['root_id'] ? '#' . $page['root_id'] : '',
                'authNonce'       => wp_create_nonce('wap_client_auth'),
                'deleteDataNonce' => wp_create_nonce('wap_client_delete_data'),
                'consentNonce'    => wp_create_nonce('wap_client_consent'),
                'wapBrowserUrl'   => esc_url_raw($page['server_url']),
                'product'         => esc_js($page['product']),
                'mode'            => esc_js($page['mode']),
                'pageContext'     => esc_js($page['page_context']),
                'menuSlug'        => esc_js($menu_slug),
                // Per-site MCP endpoint (default: this site's default MCP server).
                // The widget ships it on every chat request as `mcp_endpoint` in the
                // body so the WAP backend can route tool calls to the right host —
                // required on OneHop multi-tenant clusters where the GRND's signed
                // sub is the cluster domain, not the per-site prefix. Hosts that
                // run on a different MCP route can override the filter.
                'mcpEndpoint'     => esc_url_raw( apply_filters(
                    'wap_client_mcp_endpoint',
                    home_url( '/wp-json/mcp/mcp-adapter-default-server' )
                ) ),
                'userInitial'     => esc_js(self::user_initial()),
                'version'         => WAP_CLIENT_VERSION,
                'termsUrl'        => esc_url_raw($page['terms_url']),
                'privacyUrl'      => esc_url_raw($page['privacy_url']),
                // Mixpanel client-side analytics. All optional; the widget is
                // inert without mixpanelToken. Governed mandatory props are sent
                // as super-properties: application, page (derived), and brand
                // (only when configured — no WP-family→brand mapping exists yet).
                'mixpanelToken'       => esc_js($mixpanel_token),
                'mixpanelLibUrl'      => esc_url_raw($mixpanel_lib_url),
                'mixpanelLoaderUrl'   => esc_url_raw($mixpanel_loader_url),
                'mixpanelApiHost'     => esc_url_raw( apply_filters('wap_client_mixpanel_api_host', 'https://api-eu.mixpanel.com') ),
                'mixpanelApplication' => esc_js( (string) apply_filters('wap_client_mixpanel_application', 'wap') ),
                'mixpanelBrand'       => esc_js( (string) apply_filters('wap_client_mixpanel_brand', '') ),
                // Per-tenant brand stylesheet URL. The widget appends it as the
                // final <link> in <head>, so tenant rules override our standard
                // ones (later same-specificity rule wins). Empty string = none.
                'customCssUrl'    => esc_url_raw((string) apply_filters(
                    'wap_client_custom_css_url',
                    $page['custom_css_url'],
                    $page['product']
                )),
                // cfg.layout — re-sanitised after the filter (so an override
                // can't smuggle unsafe values); cast to object so an empty
                // layout serialises as `{}`, not `[]`.
                'layout'          => (object) self::sanitize_layout( apply_filters(
                    'wap_client_layout',
                    $page['layout'],
                    $page['product']
                ) ),
                // `null` (not an empty object) for a menu page, so the widget
                // can tell "no column" from "all-default framing".
                'column'          => $page['column']
                    ? (object) self::column_config($menu_slug, $page)
                    : null,
                // WordPress admin time-format setting (PHP date() tokens). The JS
                // widget formats message timestamps client-side using this string
                // so times honour the site's configured format.
                'timeFormat'      => get_option('time_format', 'H:i'),
                // Active admin locale — surfaced for reference/debug; UI strings are
                // already translated server-side via the i18n array below.
                'locale'          => determine_locale(),
                'suggestions'     => apply_filters(
                    'wap_client_suggestions',
                    [
                        __('What can you help me with?', 'wap-client'),
                        __('How do I speed up my site?', 'wap-client'),
                        __('Summarise my recent activity', 'wap-client'),
                    ],
                    $page['product']
                ),
                'i18n'            => [
                    'assistantName'  => esc_html($page['menu_title']),
                    'you'            => __('You', 'wap-client'),
                    'welcomeTitle'   => __('How can I help?', 'wap-client'),
                    'welcomeSubtitle'=> __('Ask me anything about your site, content, or settings.', 'wap-client'),
                    'agentSelector'  => __('Assistant', 'wap-client'),
                    'hint'           => __('Enter to send · Shift+Enter for a new line', 'wap-client'),
                    'placeholder'    => __('Ask the AI agent…', 'wap-client'),
                    'send'           => __('Send', 'wap-client'),
                    'stop'           => __('Stop', 'wap-client'),
                    'newChat'        => __('New chat', 'wap-client'),
                    'scrollDown'     => __('Scroll to bottom', 'wap-client'),
                    'thinking'       => __('Thinking…', 'wap-client'),
                    'working'        => __('Working…', 'wap-client'),
                    'analyzing'      => __('Analyzing the website…', 'wap-client'),
                    'retrieving'     => __('Retrieving configuration…', 'wap-client'),
                    'applying'       => __('Interacting with WordPress…', 'wap-client'),
                    'searching'      => __('Searching the web…', 'wap-client'),
                    'reading'        => __('Reading a page…', 'wap-client'),
                    'consulting'     => __('Consulting multiple specialists…', 'wap-client'),
                    'loadingHistory' => __('Loading your conversation…', 'wap-client'),
                    'reconnecting'   => __('Connecting…', 'wap-client'),
                    'connected'      => __('Connected', 'wap-client'),
                    'disconnected'   => __('Disconnected', 'wap-client'),
                    'actionLabel'    => __('Action', 'wap-client'),
                    'showDetails'    => __('Show details', 'wap-client'),
                    'hideDetails'    => __('Hide details', 'wap-client'),
                    'otherOption'    => __('Other…', 'wap-client'),
                    'otherPlaceholder' => __('Type your answer…', 'wap-client'),
                    'submitAnswer'   => __('Send', 'wap-client'),
                    'confirmAnswer'  => __('Confirm', 'wap-client'),
                    'selectOne'      => __('Select one', 'wap-client'),
                    'selectMany'     => __('Select at least one', 'wap-client'),
                    'nSelected'      => __('{n} selected.', 'wap-client'),
                    'selectAtLeastOne' => __('Select at least 1 option.', 'wap-client'),
                    'stepDone'       => __(', done', 'wap-client'),
                    'stepWorking'    => __(', in progress', 'wap-client'),
                    'termsLabel'     => __('Terms & Conditions', 'wap-client'),
                    // Footer legal notice. {terms} and {privacy} are replaced with
                    // the Terms of Use / Privacy Policy links (see buildMetaBar()).
                    'aiLegalNotice'  => __('This tool uses AI to generate content. Accuracy and legal compliance are not guaranteed. By using this tool you agree to {terms} and acknowledge {privacy}.', 'wap-client'),
                    'termsOfUseLabel'=> __('Terms of Use', 'wap-client'),
                    'privacyLabel'   => __('Privacy Policy', 'wap-client'),
                    'deleteData'     => __('Delete my data', 'wap-client'),
                    'deleteTooltip'  => __('Delete data for this chat session', 'wap-client'),
                    'deleteTitle'    => __('Delete your data?', 'wap-client'),
                    'cancel'         => __('Cancel', 'wap-client'),
                    'deleteConfirm'  => __('This will permanently delete all your conversation history with the AI assistant. This action cannot be undone.', 'wap-client'),
                    'deleteSuccess'  => __('Your data has been deleted.', 'wap-client'),
                    'errorGeneric'   => __('An error occurred. Please try again.', 'wap-client'),
                    'errorRateLimit' => __('Too many requests. Please wait before sending another message.', 'wap-client'),
                    // Shown when WAP keeps rejecting freshly minted GRNDs — the
                    // widget stops re-minting after MAX_REAUTH_ATTEMPTS rather
                    // than looping, and offers this notice plus a retry button.
                    'errorAuthFailed'=> __('Could not connect to the AI assistant. Please reload the page, or contact support if this continues.', 'wap-client'),
                    'errorRetry'     => __('Try again', 'wap-client'),
                    'errorQuota'     => __('You have reached your monthly message limit. It resets at the start of next month.', 'wap-client'),
                    'errorReference' => __('Reference:', 'wap-client'),
                    // Keep the {placeholders} — the widget fills them in.
                    'quotaRemaining' => __('{remaining} of {total} messages left', 'wap-client'),
                    'quotaResetsAt'  => __('Resets on {date} at {time}', 'wap-client'),
                    'quotaLow'       => __('Only {remaining} of {total} messages left this month. Your quota renews on {date} at {time}.', 'wap-client'),
                    'quotaExhausted' => __('Limit reached. Your quota will renew on {date} at {time}.', 'wap-client'),
                    'quotaBlocked'   => __('Message limit reached', 'wap-client'),
                    'consentTitle'   => __('Before you start', 'wap-client'),
                    'consentText'    => __('Please review and accept the Terms & Conditions for the AI assistant.', 'wap-client'),
                    'consentAgree'   => __('Agree and continue', 'wap-client'),
                    'consentRequired'=> __('You need to accept the Terms & Conditions to use the AI assistant.', 'wap-client'),
                    'consentReview'  => __('Review Terms & Conditions', 'wap-client'),
                    // Header actions + New-chat confirmation.
                    'settings'       => __('Chat settings', 'wap-client'),
                    'fullscreen'     => __('Full screen', 'wap-client'),
                    'exitFullscreen' => __('Exit full screen', 'wap-client'),
                    'newChatTitle'   => __('Start a new chat?', 'wap-client'),
                    'newChatConfirm' => __('This clears the current conversation and its history. Anything I’ve remembered about you is kept.', 'wap-client'),
                    // Chat settings panel.
                    'settingsTitle'  => __('Chat settings', 'wap-client'),
                    'preferences'    => __('Preferences', 'wap-client'),
                    'language'       => __('Language', 'wap-client'),
                    'languageNote'   => __('Set by your account language.', 'wap-client'),
                    'aboutChat'      => __('About this chat', 'wap-client'),
                    'assistantLabel' => __('Assistant', 'wap-client'),
                    'productLabel'   => __('Product', 'wap-client'),
                    'versionLabel'   => __('Version', 'wap-client'),
                    'settingsNote'   => __('Starting a new chat clears this conversation. We keep only a short internal summary of it to see how the assistant is doing — never shown to you or used in future chats.', 'wap-client'),
                    'columnLabel'    => __('AI assistant', 'wap-client'),
                    'openAssistant'  => __('Open the AI assistant', 'wap-client'),
                    'closeAssistant' => __('Hide the AI assistant', 'wap-client'),
                    'readOnly'       => __('Read-only', 'wap-client'),
                ],
            ]
        );
    }

    /**
     * First initial of the current user, used for the user avatar.
     *
     * @return string A single uppercase character, or 'Y' as a fallback.
     */
    private static function user_initial(): string
    {
        $user = wp_get_current_user();
        $name = $user && $user->exists()
            ? ($user->display_name ?: $user->user_login)
            : '';
        $first = trim((string) $name) !== '' ? mb_substr(trim($name), 0, 1) : 'Y';
        return strtoupper($first);
    }

    // -------------------------------------------------------------------------
    // Layout sanitisation
    // -------------------------------------------------------------------------

    /**
     * Reduce a caller-supplied layout array to known-safe values: enums
     * whitelisted, CSS length/colour pattern-validated, unknown keys dropped.
     *
     * @param mixed $raw Raw layout value from register() args or a filter.
     * @return array<string, string|bool> Sanitised layout map (may be empty).
     */
    private static function sanitize_layout($raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];

        $enums = [
            'width'        => ['boxed', 'fluid'],
            'align'        => ['left', 'center', 'right'],
            'chrome'       => ['card', 'flat'],
            'expandToggle' => ['off', 'container', 'window'],
        ];
        foreach ($enums as $key => $allowed) {
            if (isset($raw[$key]) && in_array($raw[$key], $allowed, true)) {
                $out[$key] = $raw[$key];
            }
        }

        // Inner-column cap: a plain CSS length (number + unit). Complex values
        // (calc(), min()) are intentionally not accepted over the PHP path.
        if (isset($raw['innerWidth']) && self::is_css_length((string) $raw['innerWidth'])) {
            $out['innerWidth'] = (string) $raw['innerWidth'];
        }

        // Height: a plain CSS length or the 'fill' keyword.
        if (isset($raw['height'])) {
            $height = (string) $raw['height'];
            if ($height === 'fill' || self::is_css_length($height)) {
                $out['height'] = $height;
            }
        }

        // Accent colour applied as --color-primary.
        if (isset($raw['accent']) && self::is_css_color((string) $raw['accent'])) {
            $out['accent'] = (string) $raw['accent'];
        }

        foreach (['keepScrollbar', 'showHeader', 'showNewChat', 'showSettings', 'showDeleteData'] as $flag) {
            if (isset($raw[$flag])) {
                $out[$flag] = (bool) $raw[$flag];
            }
        }

        return $out;
    }

    /**
     * Reduce a caller-supplied column config to known-safe values.
     *
     * Enums whitelisted, lengths pattern-validated, unknown keys dropped.
     * Empty for a surface that is not a column.
     *
     * Unlike sanitize_layout(), enums resolve to a default rather than being
     * dropped, so the result is always complete and safe to re-run over a
     * filtered value.
     *
     * @param mixed $raw Raw column value from register() args or a filter.
     * @return array<string, string|bool> Sanitised column map (may be empty).
     */
    private static function sanitize_column($raw): array
    {
        if (!is_array($raw) || [] === $raw) {
            return [];
        }

        $out = ['enabled' => true];

        $enums = [
            'side'         => [['left', 'right'], 'right'],
            'mode'         => [['push', 'overlay'], 'push'],
            'defaultState' => [['collapsed', 'expanded'], 'collapsed'],
        ];
        foreach ($enums as $key => [$allowed, $default]) {
            $out[$key] = (isset($raw[$key]) && in_array($raw[$key], $allowed, true))
                ? $raw[$key]
                : $default;
        }

        // Left absent when unusable, so the widget's own default applies.
        foreach (['width', 'breakpoint'] as $key) {
            if (isset($raw[$key]) && self::is_css_length((string) $raw[$key])) {
                $out[$key] = (string) $raw[$key];
            }
        }

        foreach (['showLauncher', 'persist'] as $flag) {
            if (isset($raw[$flag])) {
                $out[$flag] = (bool) $raw[$flag];
            }
        }

        return $out;
    }

    /**
     * True for a plain CSS length: an integer/decimal with a known unit or %.
     *
     * @param string $value Candidate value.
     * @return bool
     */
    private static function is_css_length(string $value): bool
    {
        return (bool) preg_match(
            '/^-?\d+(\.\d+)?(px|rem|em|ch|vw|vh|vmin|vmax|%)$/',
            trim($value)
        );
    }

    /**
     * True for a hex, rgb(a)/hsl(a), or single-token named CSS colour. Kept
     * deliberately narrow — the value is written to a CSS custom property.
     *
     * @param string $value Candidate value.
     * @return bool
     */
    private static function is_css_color(string $value): bool
    {
        $value = trim($value);
        if (preg_match('/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/', $value)) {
            return true;
        }
        if (preg_match('/^(rgb|rgba|hsl|hsla)\([0-9.,%\s\/]+\)$/', $value)) {
            return true;
        }
        // Named colours (e.g. "rebeccapurple") — letters only, no CSS syntax.
        return (bool) preg_match('/^[a-zA-Z]+$/', $value);
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
        $product   = sanitize_text_field(wp_unslash($_POST['product'] ?? ''));
        $menu_slug = sanitize_key(wp_unslash($_POST['menu_slug'] ?? ''));
        $force_new = !empty($_POST['force_new']); // Set to true when re-provisioning after 401.

        $page = self::$pages[$menu_slug] ?? null;
        if (!$page || !$product) {
            wp_send_json_error(['message' => __('Invalid request parameters.', 'wap-client')], 400);
        }

        $grnd = \WapClient::get_grnd_token([
            'product'        => $product,
            'server_url'     => $page['server_url'],
            'issuer_url'     => $page['grnd_issuer_url'],
            'license_key'    => $page['grnd_license_key'],
            'grnd_provider'  => is_callable($page['grnd_provider'] ?? null) ? $page['grnd_provider'] : null,
            'force_new'      => $force_new,
            'password_label' => $page['page_title'],
        ]);

        if (is_wp_error($grnd)) {
            // The technical reason (missing issuer config, license rejected,
            // exchange HTTP failure, …) is for the integrator, not the end
            // user — log it and reply with a generic message.
            self::log_auth_failure('GRND acquisition failed', $grnd);
            wp_send_json_error(['message' => self::unavailable_message()], 403);
        }

        // Per-call GRND transport (no session exchange): the GRND itself is
        // the widget's Bearer credential for every WAP call. The sealed
        // wp_app_token inside stays opaque to the browser — only WAP's wrap
        // key can open it. If WAP rejects it (expired/revoked → 401 on chat),
        // the widget retries this endpoint exactly once with force_new, which
        // re-mints the App Password and the GRND above. WAP derives the
        // conversation thread from the GRND claims, so no conversationId is
        // issued here; the widget picks it up from the first stream event.
        wp_send_json_success([
            'token' => $grnd,
        ]);
    }

    /**
     * Generic end-user message for any auth/provisioning failure.
     *
     * End users cannot act on technical detail (issuer config, license
     * rejection, backend status codes) — that belongs in the server log.
     *
     * @return string
     */
    private static function unavailable_message(): string
    {
        return __('The AI assistant is temporarily unavailable. Please try again in a few minutes, or contact support if the problem persists.', 'wap-client');
    }

    /**
     * Log the technical detail of an auth failure for the site owner.
     *
     * Only writes when WP_DEBUG is enabled, so production sites are not
     * spammed while integrators still get the real reason in debug.log.
     *
     * @param string    $context Short description of the failing step.
     * @param \WP_Error $error   The underlying error.
     *
     * @return void
     */
    private static function log_auth_failure(string $context, \WP_Error $error): void
    {
        if (defined('WP_DEBUG') && WP_DEBUG) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log(sprintf(
                '[wap-client] %s: [%s] %s',
                $context,
                $error->get_error_code(),
                $error->get_error_message()
            ));
        }
    }

    /**
     * AJAX handler: read or record the user's T&C consent.
     *
     * Backs the widget's default consent hook (diagram point 2). Consent is
     * stored per user and per product in user meta as an acceptance timestamp,
     * so the first-chat gate is shown once per user until they accept.
     *
     * POST params: op = 'get' | 'grant', product = product slug.
     *
     * @return void (sends JSON response and exits)
     */
    public static function ajax_consent(): void
    {
        check_ajax_referer('wap_client_consent');

        $capability = apply_filters('wap_client_capability', 'wap_use_ai');
        if (!current_user_can($capability)) {
            wp_send_json_error(['message' => __('Insufficient permissions.', 'wap-client')], 403);
        }

        $current_user = wp_get_current_user();
        if (!$current_user->exists()) {
            wp_send_json_error(['message' => __('User not authenticated.', 'wap-client')], 401);
        }

        $op      = sanitize_key(wp_unslash($_POST['op'] ?? 'get'));
        $product = sanitize_text_field(wp_unslash($_POST['product'] ?? ''));

        if (!$product || !in_array($op, ['get', 'grant'], true)) {
            wp_send_json_error(['message' => __('Invalid request parameters.', 'wap-client')], 400);
        }

        // Only accept products actually registered via register_chat_page() —
        // consent meta must not be writable for arbitrary product strings.
        $known = false;
        foreach (self::$pages as $registered) {
            if ($registered['product'] === $product) {
                $known = true;
                break;
            }
        }
        if (!$known) {
            wp_send_json_error(['message' => __('Invalid request parameters.', 'wap-client')], 400);
        }

        $meta_key = 'wap_client_consent_' . sanitize_key($product);

        if ('grant' === $op) {
            update_user_meta($current_user->ID, $meta_key, time());
            // Audit-log the acceptance under WP_DEBUG so a site owner has
            // evidence of consent (user, product, time, remote address) when
            // chasing GDPR/US12 questions. Off by default to keep production
            // logs quiet.
            if (defined('WP_DEBUG') && WP_DEBUG) {
                // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log, WordPress.Security.ValidatedSanitizedInput
                error_log(sprintf(
                    '[wap-client] consent_granted user_id=%d product=%s ip=%s',
                    $current_user->ID,
                    $product,
                    isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : ''
                ));
            }
            wp_send_json_success(['granted' => true]);
        }

        wp_send_json_success([
            'granted' => (bool) get_user_meta($current_user->ID, $meta_key, true),
        ]);
    }
}
