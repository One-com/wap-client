<?php
/**
 * Standalone unit tests for ChatWidget page modes (WPIN-8799, WPIN-8800).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-chat-widget-page-modes.php
 *
 * Exits 0 when all assertions pass, 1 otherwise. Covers hidden_admin_menu
 * registration, render_mode dispatch, standalone layout defaults and asset
 * loading, the render callback contract, and output escaping.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');
define('WAP_CLIENT_VERSION', '1.0.0');
define('WAP_CLIENT_URL', 'https://customer-site.test/wp-content/plugins/my-plugin/vendor/groupone/wap-client/');

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

$GLOBALS['wap_hooks']     = [];
$GLOBALS['wap_menu_calls'] = [];
$GLOBALS['wap_styles']    = [];
$GLOBALS['wap_scripts']   = [];
$GLOBALS['wap_localized'] = [];
$GLOBALS['wap_can']       = true;

class WapTestDied extends \Exception
{
}

function add_action(string $hook, $callback, int $priority = 10, int $accepted_args = 1): bool
{
    $GLOBALS['wap_hooks'][$hook][] = $callback;
    return true;
}

function add_filter(string $hook, $callback, int $priority = 10, int $accepted_args = 1): bool
{
    return add_action($hook, $callback, $priority, $accepted_args);
}

function has_action(string $hook): bool
{
    return !empty($GLOBALS['wap_hooks'][$hook]);
}

function do_action(string $hook, ...$args): void
{
    $GLOBALS['wap_fired'][] = $hook;
    foreach ($GLOBALS['wap_hooks'][$hook] ?? [] as $callback) {
        $callback(...$args);
    }
}

function apply_filters(string $hook, $value, ...$args)
{
    foreach ($GLOBALS['wap_hooks'][$hook] ?? [] as $callback) {
        $value = $callback($value, ...$args);
    }
    return $value;
}

function current_user_can(string $capability): bool
{
    return (bool) $GLOBALS['wap_can'];
}

function wp_die(string $message = ''): void
{
    throw new WapTestDied($message);
}

/**
 * Mirrors how WordPress derives a plugin page hook suffix closely enough for
 * these assertions: an empty parent yields the `admin_page_` prefix, which is
 * exactly what makes a hidden page reachable at admin.php?page={slug}.
 */
function add_submenu_page(
    string $parent_slug,
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = ''
) {
    $GLOBALS['wap_menu_calls'][] = [
        'fn'          => 'add_submenu_page',
        'parent_slug' => $parent_slug,
        'page_title'  => $page_title,
        'menu_title'  => $menu_title,
        'capability'  => $capability,
        'menu_slug'   => $menu_slug,
        'callback'    => $callback,
    ];

    $hook = '' === $parent_slug
        ? 'admin_page_' . $menu_slug
        : str_replace('.php', '', $parent_slug) . '_page_' . $menu_slug;

    if ($callback) {
        add_action($hook, $callback);
    }
    return $hook;
}

function add_menu_page(
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = '',
    string $icon_url = '',
    ?int $position = null
) {
    $GLOBALS['wap_menu_calls'][] = [
        'fn'         => 'add_menu_page',
        'page_title' => $page_title,
        'menu_title' => $menu_title,
        'capability' => $capability,
        'menu_slug'  => $menu_slug,
        'callback'   => $callback,
    ];

    $hook = 'toplevel_page_' . $menu_slug;
    if ($callback) {
        add_action($hook, $callback);
    }
    return $hook;
}

function wp_enqueue_style(string $handle, string $src = '', array $deps = [], $ver = null): void
{
    $GLOBALS['wap_styles'][$handle] = ['src' => $src, 'deps' => $deps, 'ver' => $ver];
}

function wp_enqueue_script(
    string $handle,
    string $src = '',
    array $deps = [],
    $ver = null,
    bool $in_footer = false
): void {
    $GLOBALS['wap_scripts'][$handle] = ['src' => $src, 'deps' => $deps, 'in_footer' => $in_footer];
}

function wp_localize_script(string $handle, string $object_name, array $data): bool
{
    $GLOBALS['wap_localized'][$handle] = $data;
    return true;
}

// render_chat_root() consults AppPasswordManager::are_app_passwords_available(),
// which falls back to is_ssl() when wp_is_application_passwords_available()
// isn't defined (as in this suite). Defaults true so every other case in this
// file renders the widget as before; the WPIN-9065 block below flips it off.
function is_ssl(): bool
{
    return $GLOBALS['wap_ssl'] ?? true;
}

function sanitize_key(string $key): string
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower($key));
}

function sanitize_html_class(string $class): string
{
    return preg_replace('/[^A-Za-z0-9_-]/', '', $class);
}

function sanitize_text_field(string $str): string
{
    return trim(strip_tags($str));
}

function esc_url_raw(string $url): string
{
    return $url;
}

function esc_attr(string $text): string
{
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
}

function esc_html(string $text): string
{
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
}

function esc_js(string $text): string
{
    return $text;
}

function wp_kses_post(string $text): string
{
    return $text;
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

function esc_html__(string $text, string $domain = 'default'): string
{
    return esc_html($text);
}

function esc_html_e(string $text, string $domain = 'default'): void
{
    echo esc_html($text);
}

function _doing_it_wrong(string $function, string $message, string $version): void
{
    $GLOBALS['wap_doing_it_wrong'][] = $message;
}

function home_url(string $path = ''): string
{
    return 'https://customer-site.test' . $path;
}

function admin_url(string $path = ''): string
{
    return 'https://customer-site.test/wp-admin/' . $path;
}

function wp_create_nonce(string $action = ''): string
{
    return 'nonce-' . $action;
}

function get_option(string $option, $default = false)
{
    return $default;
}

function get_bloginfo(string $show = ''): string
{
    return 'UTF-8';
}

function determine_locale(): string
{
    return 'en_US';
}

function language_attributes(): void
{
    echo 'lang="en-US"';
}

function nocache_headers(): void
{
    $GLOBALS['wap_nocache'] = true;
}

/**
 * Mirrors core's wp_admin_viewport_meta() (WP 5.5+), including the exact
 * content string, so tests can assert which side emitted the tag.
 */
function wp_admin_viewport_meta(): void
{
    $viewport = apply_filters('admin_viewport_meta', 'width=device-width,initial-scale=1.0');
    if (empty($viewport)) {
        return;
    }
    echo '<meta name="viewport" content="' . esc_attr($viewport) . '">';
}

function wp_get_current_user()
{
    return new class {
        public string $display_name = 'Ada';
        public string $user_login   = 'ada';

        public function exists(): bool
        {
            return true;
        }
    };
}

require_once __DIR__ . '/../includes/class-app-password-manager.php';
require_once __DIR__ . '/../includes/class-chat-widget.php';

use GroupOne\WapClient\ChatWidget;

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

$failures = 0;

function check(string $name, bool $condition): void
{
    global $failures;
    if ($condition) {
        echo "  ok  {$name}\n";
    } else {
        $failures++;
        echo "FAIL  {$name}\n";
    }
}

/**
 * setAccessible() has been a no-op since PHP 8.1 and is deprecated in 8.5 —
 * where the notice would be captured by the output buffers these tests use —
 * but it is still required on the PHP 7.4 floor the package supports.
 *
 * @param ReflectionProperty|ReflectionMethod $ref
 */
function unlock($ref)
{
    if (PHP_VERSION_ID < 80100) {
        $ref->setAccessible(true);
    }
    return $ref;
}

function pages_property(): ReflectionProperty
{
    return unlock(new ReflectionProperty(ChatWidget::class, 'pages'));
}

/**
 * Reset all shim state and ChatWidget's static page registry between cases.
 */
function reset_state(): void
{
    $GLOBALS['wap_hooks']      = [];
    $GLOBALS['wap_menu_calls'] = [];
    $GLOBALS['wap_styles']     = [];
    $GLOBALS['wap_scripts']    = [];
    $GLOBALS['wap_localized']  = [];
    $GLOBALS['wap_fired']      = [];
    $GLOBALS['wap_can']        = true;
    $GLOBALS['wap_ssl']        = true;

    pages_property()->setValue(null, []);
    unlock(new ReflectionProperty(ChatWidget::class, 'screen_owner'))->setValue(null, '');
}

/**
 * @return array<string, mixed> The stored record for a registered page.
 */
function page_record(string $menu_slug): array
{
    return pages_property()->getValue()[$menu_slug] ?? [];
}

function call_private(string $method, array $args = [])
{
    return unlock(new ReflectionMethod(ChatWidget::class, $method))->invokeArgs(null, $args);
}

/**
 * Register a page, then run the admin_menu hook it queued.
 *
 * @param array<string, mixed> $args
 */
function register_and_build_menu(array $args): void
{
    ChatWidget::register($args);
    do_action('admin_menu');
}

/**
 * @return array<string, mixed> Base args every case needs.
 */
function base_args(array $overrides = []): array
{
    return array_merge([
        'menu_slug'  => 'my-plugin-chat',
        'page_title' => 'AI Assistant',
        'menu_title' => 'AI Assistant',
        'product'    => 'my-product',
        'server_url' => 'https://wap.test',
        'grnd'       => ['issuer_url' => 'https://api.brand.test/grnd', 'license_key' => 'SECRET-LICENSE'],
    ], $overrides);
}

// -----------------------------------------------------------------------------
// WPIN-8799 — hidden admin menu
// -----------------------------------------------------------------------------

echo "\nWPIN-8799 — hidden admin page\n";

reset_state();
register_and_build_menu(base_args(['hidden_admin_menu' => true]));
$calls = $GLOBALS['wap_menu_calls'];

check('hidden page registers via add_submenu_page', count($calls) === 1 && 'add_submenu_page' === $calls[0]['fn']);
check('hidden page passes an empty parent slug', ($calls[0]['parent_slug'] ?? null) === '');
check(
    'hidden page never calls add_menu_page',
    0 === count(array_filter($calls, static fn (array $c): bool => 'add_menu_page' === $c['fn']))
);
check(
    'hidden page still wires a render callback (admin.php refuses a hookless page)',
    !empty($calls[0]['callback']) && has_action('admin_page_my-plugin-chat')
);

reset_state();
register_and_build_menu(base_args(['hidden_admin_menu' => true, 'parent_slug' => 'my-plugin-settings']));
check(
    'hidden_admin_menu takes precedence over parent_slug',
    'add_submenu_page' === $GLOBALS['wap_menu_calls'][0]['fn']
    && '' === $GLOBALS['wap_menu_calls'][0]['parent_slug']
);

reset_state();
register_and_build_menu(base_args());
check('no parent and not hidden → top-level menu', 'add_menu_page' === $GLOBALS['wap_menu_calls'][0]['fn']);

reset_state();
register_and_build_menu(base_args(['parent_slug' => 'my-plugin-settings']));
check(
    'parent_slug alone still nests under that parent',
    'add_submenu_page' === $GLOBALS['wap_menu_calls'][0]['fn']
    && 'my-plugin-settings' === $GLOBALS['wap_menu_calls'][0]['parent_slug']
);

reset_state();
$GLOBALS['wap_can'] = false;
register_and_build_menu(base_args(['hidden_admin_menu' => true]));
check('a user without the capability gets no page at all', [] === $GLOBALS['wap_menu_calls']);

// -----------------------------------------------------------------------------
// WPIN-8800 — render_mode
// -----------------------------------------------------------------------------

echo "\nWPIN-8800 — render_mode dispatch\n";

reset_state();
register_and_build_menu(base_args());
check('render_mode defaults to admin', 'admin' === page_record('my-plugin-chat')['render_mode']);
check('admin mode registers no load- hook', !has_action('load-toplevel_page_my-plugin-chat'));

reset_state();
register_and_build_menu(base_args(['hidden_admin_menu' => true, 'render_mode' => 'standalone']));
check('render_mode standalone is stored', 'standalone' === page_record('my-plugin-chat')['render_mode']);
check(
    'standalone renders on load-{hook_suffix}, before admin-header.php',
    has_action('load-admin_page_my-plugin-chat')
);
check('hook suffix is captured for later use', 'admin_page_my-plugin-chat' === page_record('my-plugin-chat')['hook_suffix']);

reset_state();
register_and_build_menu(base_args(['render_mode' => 'bare']));
check('an unknown render_mode falls back to admin', 'admin' === page_record('my-plugin-chat')['render_mode']);
check('an unknown render_mode registers no load- hook', !has_action('load-toplevel_page_my-plugin-chat'));

reset_state();
register_and_build_menu(base_args(['render_mode' => true]));
check('a non-string render_mode falls back to admin', 'admin' === page_record('my-plugin-chat')['render_mode']);

// -----------------------------------------------------------------------------
// Standalone layout defaults
// -----------------------------------------------------------------------------

echo "\nStandalone layout defaults\n";

reset_state();
ChatWidget::register(base_args(['render_mode' => 'standalone']));
$layout = page_record('my-plugin-chat')['layout'];
check('standalone defaults width to fluid', 'fluid' === ($layout['width'] ?? null));
check('standalone defaults height to fill', 'fill' === ($layout['height'] ?? null));
check('standalone defaults chrome to flat', 'flat' === ($layout['chrome'] ?? null));
check('standalone defaults expandToggle to off', 'off' === ($layout['expandToggle'] ?? null));

reset_state();
ChatWidget::register(base_args([
    'render_mode' => 'standalone',
    'layout'      => ['width' => 'boxed', 'chrome' => 'card'],
]));
$layout = page_record('my-plugin-chat')['layout'];
check('an explicit layout key beats the standalone default', 'boxed' === ($layout['width'] ?? null));
check('an explicit chrome beats the standalone default', 'card' === ($layout['chrome'] ?? null));
check('unspecified keys still take the standalone default', 'fill' === ($layout['height'] ?? null));

reset_state();
ChatWidget::register(base_args());
check('admin mode gets no implicit layout', [] === page_record('my-plugin-chat')['layout']);

// -----------------------------------------------------------------------------
// Assets
// -----------------------------------------------------------------------------

echo "\nStandalone assets\n";

reset_state();
register_and_build_menu(base_args(['hidden_admin_menu' => true, 'render_mode' => 'standalone']));
do_action('admin_enqueue_scripts', 'admin_page_my-plugin-chat');

check('standalone enqueues the document-shell stylesheet', isset($GLOBALS['wap_styles']['wap-client-standalone-my-plugin-chat']));
check(
    'shell stylesheet loads after the widget stylesheet',
    in_array(
        'wap-client-chat-my-plugin-chat',
        $GLOBALS['wap_styles']['wap-client-standalone-my-plugin-chat']['deps'] ?? [],
        true
    )
);
check('standalone still enqueues the widget script', isset($GLOBALS['wap_scripts']['wap-client-chat-my-plugin-chat']));
check(
    'standalone layout reaches the widget config',
    'fluid' === ($GLOBALS['wap_localized']['wap-client-chat-my-plugin-chat']['layout']->width ?? null)
);

reset_state();
register_and_build_menu(base_args());
do_action('admin_enqueue_scripts', 'toplevel_page_my-plugin-chat');
check('admin mode does not load the shell stylesheet', !isset($GLOBALS['wap_styles']['wap-client-standalone-my-plugin-chat']));

reset_state();
register_and_build_menu(base_args([
    'render_mode'          => 'standalone',
    'standalone_shell_css' => false,
]));
do_action('admin_enqueue_scripts', 'admin_page_my-plugin-chat');
check(
    'standalone_shell_css => false skips the shell stylesheet',
    !isset($GLOBALS['wap_styles']['wap-client-standalone-my-plugin-chat'])
);
check(
    'opting out still enqueues the widget stylesheet',
    isset($GLOBALS['wap_styles']['wap-client-chat-my-plugin-chat'])
);
check(
    'opting out still enqueues the widget script',
    isset($GLOBALS['wap_scripts']['wap-client-chat-my-plugin-chat'])
);

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
add_filter('wap_client_standalone_shell_css', static function (): bool {
    return false;
});
do_action('admin_enqueue_scripts', 'admin_page_my-plugin-chat');
check(
    'the shell stylesheet can be filtered off',
    !isset($GLOBALS['wap_styles']['wap-client-standalone-my-plugin-chat'])
);

// -----------------------------------------------------------------------------
// Standalone document
// -----------------------------------------------------------------------------

echo "\nStandalone document\n";

reset_state();
register_and_build_menu(base_args([
    'hidden_admin_menu' => true,
    'render_mode'       => 'standalone',
    'page_title'        => 'Set up <b>your</b> site',
]));

ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();

check('document opens with a doctype', 0 === strpos(ltrim($html), '<!DOCTYPE html>'));
check('document carries no wp-admin page wrapper', false === strpos($html, 'class="wrap'));
check('document mounts the widget container', false !== strpos($html, 'id="wap-chat-root"'));
check('document wraps the widget in the standalone shell', false !== strpos($html, 'wap-standalone-shell'));
check('page title is escaped in the title element', false !== strpos($html, '<title>Set up &lt;b&gt;your&lt;/b&gt; site</title>'));
check('body carries the standalone class', false !== strpos($html, 'class="wap-standalone wap-standalone-my-plugin-chat"'));
check('robots meta keeps the page out of indexes', false !== strpos($html, 'name="robots"'));

$fired = $GLOBALS['wap_fired'];
check('head asset hooks fire in admin-header.php order', array_slice(array_values(array_filter($fired, static function (string $h): bool {
    return in_array($h, ['admin_enqueue_scripts', 'admin_print_styles', 'admin_print_scripts', 'admin_head'], true);
})), 0, 4) === ['admin_enqueue_scripts', 'admin_print_styles', 'admin_print_scripts', 'admin_head']);
check('footer script hooks fire so the widget can boot', in_array('admin_print_footer_scripts', $fired, true));
check('the page-scoped admin_footer hook fires', in_array('admin_footer-admin_page_my-plugin-chat', $fired, true));
check('the global admin_footer hook is deliberately not fired', !in_array('admin_footer', $fired, true));

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
add_filter('wap_client_standalone_body_class', static function (array $classes): array {
    $classes[] = 'my wizard';
    return $classes;
});
ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();
check('a filtered body class is applied', false !== strpos($html, 'mywizard'));
check('a filtered body class is sanitised', false === strpos($html, 'my wizard'));

// -----------------------------------------------------------------------------
// Viewport meta — MR !54 review
//
// A standalone document skips admin-header.php. Core does not emit the viewport
// inline there; wp_admin_viewport_meta() is hooked to admin_head (WP 5.5+),
// which this renderer fires. Assert the document ends up with exactly one
// viewport meta whether or not that core hook is present, so the page is never
// left unresponsive on mobile and never ships a duplicate tag.
// -----------------------------------------------------------------------------

echo "\nViewport meta\n";

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
add_action('admin_head', 'wp_admin_viewport_meta');
ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();
check('core hook present → exactly one viewport meta', 1 === substr_count($html, 'name="viewport"'));
check('core hook present → the tag is core\'s', false !== strpos($html, 'content="width=device-width,initial-scale=1.0"'));

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();
check('core hook absent → we emit exactly one viewport meta', 1 === substr_count($html, 'name="viewport"'));
check('our fallback is device-width', false !== strpos($html, 'width=device-width'));

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
add_filter('admin_viewport_meta', static fn (): string => '');
ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();
check('an empty admin_viewport_meta filter suppresses the tag', 0 === substr_count($html, 'name="viewport"'));

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone', 'page_title' => '']));
ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();
check('an empty page_title falls back to menu_title for the document title', false !== strpos($html, '<title>AI Assistant</title>'));

// -----------------------------------------------------------------------------
// render callback
// -----------------------------------------------------------------------------

echo "\nrender callback\n";

reset_state();
$captured = null;
register_and_build_menu(base_args([
    'render_mode' => 'standalone',
    'render'      => static function (array $config) use (&$captured): void {
        $captured = $config;
        echo '<header class="my-wizard-header">Step 1</header>';
        ChatWidget::render_chat_root($config['menu_slug']);
    },
]));

ob_start();
call_private('output_standalone_document', [page_record('my-plugin-chat')]);
$html = (string) ob_get_clean();

check('render callback output is emitted', false !== strpos($html, 'my-wizard-header'));
check('render callback can still mount the widget', false !== strpos($html, 'id="wap-chat-root"'));
check('render callback receives the menu slug', 'my-plugin-chat' === ($captured['menu_slug'] ?? null));
check('render callback receives the render mode', 'standalone' === ($captured['render_mode'] ?? null));
check('render callback is not handed the license key', is_array($captured) && !array_key_exists('grnd_license_key', $captured));
check('render callback is not handed the issuer url', is_array($captured) && !array_key_exists('grnd_issuer_url', $captured));
check('render callback is not handed the grnd provider', is_array($captured) && !array_key_exists('grnd_provider', $captured));

reset_state();
register_and_build_menu(base_args(['render' => 'not-a-callable']));
check('a non-callable render arg is ignored', null === page_record('my-plugin-chat')['render']);

ob_start();
call_private('render_page', ['my-plugin-chat']);
$html = (string) ob_get_clean();
check('admin mode without a render callback keeps the page heading', false !== strpos($html, '<h1>'));
check('admin mode keeps the wp-admin page wrapper', false !== strpos($html, 'class="wrap wap-client-wrap'));

reset_state();
register_and_build_menu(base_args([
    'render' => static function (array $config): void {
        echo '<p>custom</p>';
    },
]));
ob_start();
call_private('render_page', ['my-plugin-chat']);
$html = (string) ob_get_clean();
check('a render callback works in admin mode too', false !== strpos($html, '<p>custom</p>'));
check('a render callback owns the heading', false === strpos($html, '<h1>'));
check('admin mode still provides the wp-admin wrapper', false !== strpos($html, 'class="wrap wap-client-wrap'));

// -----------------------------------------------------------------------------
// Access control and escaping
// -----------------------------------------------------------------------------

echo "\nAccess control and escaping\n";

reset_state();
register_and_build_menu(base_args(['render_mode' => 'standalone']));
$GLOBALS['wap_can'] = false;
$died = false;
try {
    call_private('render_standalone_page', ['my-plugin-chat']);
} catch (WapTestDied $e) {
    $died = true;
}
check('standalone rendering re-checks the capability before any output', $died);

reset_state();
register_and_build_menu(base_args(['product' => 'evil" onload="alert(1)']));
ob_start();
ChatWidget::render_chat_root('my-plugin-chat');
$html = (string) ob_get_clean();
check('product is escaped into the data attribute', false === strpos($html, 'onload="alert(1)'));

reset_state();
ob_start();
ChatWidget::render_chat_root('never-registered');
check('render_chat_root is a no-op for an unregistered slug', '' === trim((string) ob_get_clean()));

// -----------------------------------------------------------------------------
// WPIN-9065 — contextual Application Passwords notice
// -----------------------------------------------------------------------------
//
// The page stays registered (menu item included) even when Application
// Passwords are unavailable; render_chat_root() shows a notice scoped to this
// page in place of the mount point, instead of the surface disappearing and
// the reason only ever surfacing in a site-wide admin_notices banner.

echo "\nWPIN-9065 — contextual Application Passwords notice\n";

reset_state();
$GLOBALS['wap_ssl'] = false;
register_and_build_menu(base_args());
check('the page still registers a menu item when HTTPS is missing', 1 === count($GLOBALS['wap_menu_calls']));
check('the surface record still exists when HTTPS is missing', !empty(page_record('my-plugin-chat')));

ob_start();
ChatWidget::render_chat_root('my-plugin-chat');
$html = (string) ob_get_clean();
check('a non-HTTPS site renders the notice, not the mount point', false !== strpos($html, 'wap-client-unavailable-notice'));
check('a non-HTTPS site renders no mount point', false === strpos($html, 'id="wap-chat-root"'));
check('a non-HTTPS site is told HTTPS is required', false !== strpos($html, 'requires HTTPS'));

reset_state();
$GLOBALS['wap_ssl'] = true;
register_and_build_menu(base_args());
ob_start();
ChatWidget::render_chat_root('my-plugin-chat');
$html = (string) ob_get_clean();
check('an HTTPS site with Application Passwords available renders the mount point', false !== strpos($html, 'id="wap-chat-root"'));
check('no notice is rendered when Application Passwords are available', false === strpos($html, 'wap-client-unavailable-notice'));

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
