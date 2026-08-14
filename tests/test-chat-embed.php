<?php
/**
 * Standalone unit tests for ChatEmbed — the inline chatbox with no admin page
 * (WPIN-8839).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-chat-embed.php
 *
 * Exits 0 when all assertions pass, 1 otherwise. Covers embed registration and
 * layout defaults, the absence of any menu/page registration, host-driven screen
 * opt-in (including the fail-closed default), surface precedence against chat
 * pages and columns, capability gating, config delivery (notably cfg.root and a
 * null cfg.column), and both render paths.
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
$GLOBALS['wap_styles']    = [];
$GLOBALS['wap_scripts']   = [];
$GLOBALS['wap_localized'] = [];
$GLOBALS['wap_can']       = true;
$GLOBALS['wap_screen']    = null;
$GLOBALS['wap_menu_calls'] = [];

class WapTestDied extends \Exception
{
}

function add_action(string $hook, $callback, int $priority = 10, int $accepted_args = 1): bool
{
    $GLOBALS['wap_hooks'][$hook][] = ['cb' => $callback, 'priority' => $priority];
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

/**
 * Fire a hook honouring priority order, as WordPress does — the embed/column
 * precedence rule depends on it.
 */
function do_action(string $hook, ...$args): void
{
    $callbacks = $GLOBALS['wap_hooks'][$hook] ?? [];
    usort($callbacks, static fn (array $a, array $b): int => $a['priority'] <=> $b['priority']);
    foreach ($callbacks as $entry) {
        ($entry['cb'])(...$args);
    }
}

function apply_filters(string $hook, $value, ...$args)
{
    $callbacks = $GLOBALS['wap_hooks'][$hook] ?? [];
    usort($callbacks, static fn (array $a, array $b): int => $a['priority'] <=> $b['priority']);
    foreach ($callbacks as $entry) {
        $value = ($entry['cb'])($value, ...$args);
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

function add_submenu_page(
    string $parent_slug,
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = ''
) {
    $GLOBALS['wap_menu_calls'][] = ['fn' => 'add_submenu_page', 'slug' => $menu_slug];
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
    $GLOBALS['wap_menu_calls'][] = ['fn' => 'add_menu_page', 'slug' => $menu_slug];
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
    $GLOBALS['wap_localized'][$handle][$object_name] = $data;
    return true;
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

function wp_unslash($value)
{
    return $value;
}

function get_current_screen()
{
    return $GLOBALS['wap_screen'];
}

function get_user_meta(int $user_id, string $key, bool $single = false)
{
    return '';
}

function update_user_meta(int $user_id, string $key, $value): bool
{
    return true;
}

function wp_get_current_user()
{
    return new class {
        public int $ID = 7;
        public string $display_name = 'Ada';
        public string $user_login   = 'ada';

        public function exists(): bool
        {
            return true;
        }
    };
}

require_once __DIR__ . '/../includes/class-screen-target.php';
require_once __DIR__ . '/../includes/class-chat-widget.php';
require_once __DIR__ . '/../includes/class-chat-column.php';
require_once __DIR__ . '/../includes/class-chat-embed.php';

use GroupOne\WapClient\ChatColumn;
use GroupOne\WapClient\ChatEmbed;
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
 * setAccessible() has been a no-op since PHP 8.1 and is deprecated in 8.5, but
 * is still required on the PHP 7.4 floor the package supports.
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

function private_prop(string $class, string $name): ReflectionProperty
{
    return unlock(new ReflectionProperty($class, $name));
}

function reset_state(): void
{
    $GLOBALS['wap_hooks']          = [];
    $GLOBALS['wap_styles']         = [];
    $GLOBALS['wap_scripts']        = [];
    $GLOBALS['wap_localized']      = [];
    $GLOBALS['wap_can']            = true;
    $GLOBALS['wap_screen']         = null;
    $GLOBALS['wap_menu_calls']     = [];
    $GLOBALS['wap_doing_it_wrong'] = [];

    private_prop(ChatWidget::class, 'pages')->setValue(null, []);
    private_prop(ChatWidget::class, 'screen_owner')->setValue(null, '');
    private_prop(ChatEmbed::class, 'embeds')->setValue(null, []);
    private_prop(ChatEmbed::class, 'active')->setValue(null, []);
    private_prop(ChatEmbed::class, 'emitted')->setValue(null, []);
    private_prop(ChatColumn::class, 'columns')->setValue(null, []);
    private_prop(ChatColumn::class, 'active')->setValue(null, []);
}

/**
 * @return array<string, mixed> Base embed args every case needs.
 */
function embed_args(array $overrides = []): array
{
    return array_merge([
        'id'         => 'content-ai',
        'product'    => 'rank-math',
        'server_url' => 'https://wap.test',
        'grnd'       => ['issuer_url' => 'https://api.brand.test/grnd', 'license_key' => 'SECRET-LICENSE'],
        'screens'    => ['toplevel_page_rank-math'],
    ], $overrides);
}

/** Fake WP_Screen. */
function screen(string $id)
{
    return new class ($id) {
        public string $id;
        public function __construct(string $id)
        {
            $this->id = $id;
        }
    };
}

/**
 * Register an embed and run the enqueue hook for a given screen.
 */
function activate(array $args, string $hook, ?string $screen_id = null): void
{
    ChatEmbed::register($args);
    $GLOBALS['wap_screen'] = $screen_id ? screen($screen_id) : null;
    do_action('admin_enqueue_scripts', $hook);
}

function embed_record(string $id): array
{
    return private_prop(ChatWidget::class, 'pages')->getValue()[$id] ?? [];
}

function rendered(string $id): string
{
    ob_start();
    ChatEmbed::render($id);
    return (string) ob_get_clean();
}

function enqueued(string $id): bool
{
    return isset($GLOBALS['wap_scripts']['wap-client-chat-' . $id]);
}

function widget_config(string $id): array
{
    return $GLOBALS['wap_localized']['wap-client-chat-' . $id]['WapClientConfig'] ?? [];
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

echo "\nRegistration\n";

reset_state();
ChatEmbed::register(embed_args(['id' => '']));
check('an empty id is rejected', !empty($GLOBALS['wap_doing_it_wrong']));
check('a rejected embed registers no surface', [] === private_prop(ChatWidget::class, 'pages')->getValue());

reset_state();
ChatEmbed::register(embed_args());
$record = embed_record('content-ai');
check('the embed is stored in the shared widget registry', !empty($record));
check('the embed is recorded as an embed surface', 'embed' === ($record['kind'] ?? null));

// The whole point of the ticket: no admin page, no menu entry, nothing to
// navigate to.
check('an embed registers no admin_menu hook', !has_action('admin_menu'));
do_action('admin_menu');
check('an embed adds no menu or submenu page', [] === $GLOBALS['wap_menu_calls']);

check('credentials are captured for the AJAX auth handler', 'SECRET-LICENSE' === ($record['grnd_license_key'] ?? null));
check('the product is captured', 'rank-math' === ($record['product'] ?? null));

// -----------------------------------------------------------------------------
// Layout defaults
// -----------------------------------------------------------------------------

echo "\nLayout defaults\n";

reset_state();
ChatEmbed::register(embed_args());
$layout = embed_record('content-ai')['layout'];
check('an embed fills the width its host gives it', 'fluid' === ($layout['width'] ?? null));
check('an embed draws no card of its own', 'flat' === ($layout['chrome'] ?? null));
// An embed sits in a container the host sized, so the library must not force a
// height on it the way a full-bleed standalone page or a docked column does.
check('an embed forces no height', !array_key_exists('height', $layout));

reset_state();
ChatEmbed::register(embed_args(['layout' => ['chrome' => 'card', 'height' => '640px', 'width' => 'boxed']]));
$layout = embed_record('content-ai')['layout'];
check('an explicit chrome beats the embed default', 'card' === ($layout['chrome'] ?? null));
check('an explicit width beats the embed default', 'boxed' === ($layout['width'] ?? null));
check('an explicit height is kept', '640px' === ($layout['height'] ?? null));

reset_state();
ChatEmbed::register(embed_args(['layout' => ['height' => 'calc(100vh - 10px)', 'chrome' => 'inflatable']]));
$layout = embed_record('content-ai')['layout'];
check('a calc() height is rejected', !array_key_exists('height', $layout));
check('an unknown chrome falls back to the embed default', 'flat' === ($layout['chrome'] ?? null));

// -----------------------------------------------------------------------------
// Screen opt-in
// -----------------------------------------------------------------------------

echo "\nScreen opt-in\n";

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
check('a hook-suffix match activates the embed', enqueued('content-ai'));
check('an active embed reports itself active', ChatEmbed::is_active('content-ai'));

reset_state();
activate(embed_args(), 'some_other_page');
check('a non-matching screen loads nothing', !enqueued('content-ai'));
check('a non-matching screen renders nothing', '' === trim(rendered('content-ai')));
check('a non-matching screen reports inactive', !ChatEmbed::is_active('content-ai'));

reset_state();
activate(embed_args(['screens' => ['post']]), 'post.php', 'post');
check('a WP_Screen id match activates the embed', enqueued('content-ai'));

reset_state();
activate(embed_args(['screens' => []]), 'toplevel_page_rank-math');
check('no screens and no should_render activates nowhere (fail closed)', !enqueued('content-ai'));

reset_state();
activate(
    embed_args([
        'screens'       => [],
        'should_render' => static fn ($screen, string $hook): bool => 'post.php' === $hook,
    ]),
    'post.php'
);
check('should_render can opt a screen in', enqueued('content-ai'));

reset_state();
activate(embed_args(['screens' => [], 'should_render' => static fn (): bool => false]), 'toplevel_page_rank-math');
check('should_render returning false keeps the embed off', !enqueued('content-ai'));

reset_state();
ChatEmbed::register(embed_args(['screens' => []]));
add_filter('wap_client_embed_screens', static function (array $screens): array {
    $screens[] = 'toplevel_page_rank-math';
    return $screens;
});
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('the screens filter can opt a screen in per site', enqueued('content-ai'));

reset_state();
ChatEmbed::register(embed_args(['screens' => []]));
add_filter('wap_client_embed_screens', static fn (array $s): array => array_merge($s, ['bad|id']));
do_action('admin_enqueue_scripts', 'bad|id');
check('the screens filter cannot smuggle an unsafe id past sanitisation', !enqueued('content-ai'));

// The embed and the column must share one screen matcher, so both accept the
// same ids — real hook suffixes carry dots and uppercase.
reset_state();
activate(embed_args(['screens' => ['edit.php']]), 'edit.php', 'edit');
check('a screen id containing a dot still matches', enqueued('content-ai'));

reset_state();
activate(embed_args(['screens' => ['toplevel_page_MyPlugin']]), 'toplevel_page_MyPlugin');
check('an uppercase hook suffix still matches', enqueued('content-ai'));

reset_state();
activate(embed_args(['screens' => ['tool<s>_page_x']]), 'tool<s>_page_x');
check('a screen id with unsafe characters is dropped', !enqueued('content-ai'));

// The embed filter must be independent of the column's.
reset_state();
ChatEmbed::register(embed_args(['screens' => []]));
add_filter('wap_client_column_screens', static fn (array $s): array => array_merge($s, ['toplevel_page_rank-math']));
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check("the column's screens filter does not opt an embed in", !enqueued('content-ai'));

// -----------------------------------------------------------------------------
// Surface precedence
// -----------------------------------------------------------------------------

echo "\nSurface precedence\n";

// A chat page is the more specific surface and the two cannot share one
// WapClientConfig global.
reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
]);
ChatEmbed::register(embed_args(['screens' => ['toplevel_page_my-plugin-chat']]));
do_action('admin_enqueue_scripts', 'toplevel_page_my-plugin-chat');
check('an embed stands down on a registered chat page screen', '' === trim(rendered('content-ai')));
check('the chat page still loads its own assets', enqueued('my-plugin-chat'));

// The page guard is exact, so a page slug that merely appears inside an
// unrelated hook must not suppress the embed.
reset_state();
ChatWidget::register([
    'menu_slug'  => 'chat',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
]);
activate(embed_args(['screens' => ['toplevel_page_my-chat-plugin']]), 'toplevel_page_my-chat-plugin');
check('a page slug that is merely a substring of the hook does not suppress the embed', enqueued('content-ai'));

// Embed beats column, whichever order the host registered them in — the embed
// activates at the earlier hook priority.
reset_state();
ChatEmbed::register(embed_args());
ChatColumn::register([
    'id'         => 'rm-column',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
    'screens'    => ['toplevel_page_rank-math'],
]);
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('the embed wins over a column on the same screen', enqueued('content-ai'));
check('the column stands down for the embed', !enqueued('rm-column'));

reset_state();
ChatColumn::register([
    'id'         => 'rm-column',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
    'screens'    => ['toplevel_page_rank-math'],
]);
ChatEmbed::register(embed_args());
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('precedence does not depend on registration order', enqueued('content-ai'));
check('the column still stands down when registered first', !enqueued('rm-column'));

// Two embeds on one screen: the widget keeps module-level state and a single
// frozen config, so the second must stand down rather than re-initialise the
// first.
reset_state();
ChatEmbed::register(embed_args());
ChatEmbed::register(embed_args(['id' => 'second-box']));
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('the first embed on a screen activates', ChatEmbed::is_active('content-ai'));
check('a second embed on the same screen stands down', !ChatEmbed::is_active('second-box'));
check('the second embed renders nothing', '' === trim(rendered('second-box')));

// Different screens are independent.
reset_state();
ChatEmbed::register(embed_args());
ChatEmbed::register(embed_args(['id' => 'editor-box', 'screens' => ['post']]));
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('an embed scoped to another screen is unaffected', !ChatEmbed::is_active('editor-box'));
check('the matching embed is active', ChatEmbed::is_active('content-ai'));

// A column on an unrelated screen is untouched by a registered embed.
reset_state();
ChatEmbed::register(embed_args());
ChatColumn::register([
    'id'         => 'rm-column',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
    'screens'    => ['toplevel_page_other'],
]);
do_action('admin_enqueue_scripts', 'toplevel_page_other');
check('a column on a screen the embed does not claim still activates', enqueued('rm-column'));

// -----------------------------------------------------------------------------
// Capability gate
// -----------------------------------------------------------------------------

echo "\nCapability gate\n";

reset_state();
ChatEmbed::register(embed_args());
$GLOBALS['wap_can'] = false;
do_action('admin_enqueue_scripts', 'toplevel_page_rank-math');
check('no capability loads no assets', !enqueued('content-ai'));
check('no capability renders no markup', '' === trim(rendered('content-ai')));
check('no capability reports inactive', !ChatEmbed::is_active('content-ai'));

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
$GLOBALS['wap_can'] = false;
check('the capability is re-checked at render time', '' === trim(rendered('content-ai')));
check('the capability is re-checked by get()', '' === ChatEmbed::get('content-ai'));
check('the capability is re-checked by is_active()', !ChatEmbed::is_active('content-ai'));

// -----------------------------------------------------------------------------
// Config delivery
// -----------------------------------------------------------------------------

echo "\nConfig delivery\n";

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
$widget = widget_config('content-ai');

// Without cfg.root the widget would look for #wap-chat-root and find nothing,
// because an embed deliberately namespaces its mount point.
check('cfg.root points the widget at the namespaced mount point', '#wap-chat-embed-root-content-ai' === ($widget['root'] ?? null));
check('an embed gets cfg.column = null so no panel chrome is built', array_key_exists('column', $widget) && null === $widget['column']);
check('cfg.layout reaches the widget', 'fluid' === ($widget['layout']->width ?? null));
check('the auth nonce is present', !empty($widget['authNonce']));
check('the menu slug is the embed id, so ajax_auth resolves the surface', 'content-ai' === ($widget['menuSlug'] ?? null));
check('the widget script is enqueued in the footer', true === ($GLOBALS['wap_scripts']['wap-client-chat-content-ai']['in_footer'] ?? null));
check('the Gravity design system is enqueued', isset($GLOBALS['wap_styles']['gravity-design-system']));
check('no standalone stylesheet is loaded for an embed', !isset($GLOBALS['wap_styles']['wap-client-standalone-content-ai']));

// A page keeps the historical default root resolution.
reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'rank-math',
    'server_url' => 'https://wap.test',
]);
do_action('admin_enqueue_scripts', 'toplevel_page_my-plugin-chat');
check('a page sends an empty cfg.root, keeping the default resolution', '' === (widget_config('my-plugin-chat')['root'] ?? null));

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

echo "\nRendering\n";

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
$html = rendered('content-ai');

check('the mount point uses the namespaced root id', false !== strpos($html, 'id="wap-chat-embed-root-content-ai"'));
check('the mount point is NOT the shared default id', false === strpos($html, 'id="wap-chat-root"'));
check('the mount point carries the widget root class', false !== strpos($html, 'class="wap-chat-root"'));
check('the product is exposed for theming', false !== strpos($html, 'data-product="rank-math"'));
// An embed sits inside the host's own chrome, so it must not bring the column
// wrapper with it.
check('no column wrapper is emitted', false === strpos($html, 'data-wap-chat-column'));

// Only ONE mount point can ever work: the widget resolves it from a single
// cfg.root selector, so a second element with the same id would sit on
// "Connecting…" forever — and duplicate ids are invalid HTML. Since the docs
// call these helpers safe to call unconditionally, the library must enforce it.
check('a second render on the same request emits nothing', '' === trim(rendered('content-ai')));
check('the second call warns the integrator rather than failing silently', !empty($GLOBALS['wap_doing_it_wrong']));

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
check('get() returns a non-empty string when active', '' !== ChatEmbed::get('content-ai'));
check('get() then render() does not emit a duplicate mount point', '' === trim(rendered('content-ai')));

reset_state();
activate(embed_args(), 'toplevel_page_rank-math');
ob_start();
ChatEmbed::render('content-ai');
$echoed = (string) ob_get_clean();
check('render() echoes the mount point on the first call', false !== strpos($echoed, 'wap-chat-embed-root-content-ai'));
check('render() after get() is what is suppressed, not the first emit', '' !== trim($echoed));

reset_state();
activate(embed_args(['product' => 'evil" onload="alert(1)']), 'toplevel_page_rank-math');
check('the product is escaped into the data attribute', false === strpos(rendered('content-ai'), 'onload="alert(1)'));

reset_state();
check('render is a no-op for an unregistered embed', '' === trim(rendered('never-registered')));
check('get is empty for an unregistered embed', '' === ChatEmbed::get('never-registered'));
check('is_active is false for an unregistered embed', !ChatEmbed::is_active('never-registered'));

// An embed that was never activated must render nothing even if the host calls
// it — otherwise a mount point would appear with no assets behind it.
reset_state();
ChatEmbed::register(embed_args());
check('a registered but never-activated embed renders nothing', '' === trim(rendered('content-ai')));

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
