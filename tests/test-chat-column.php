<?php
/**
 * Standalone unit tests for ChatColumn — the docked chat column (WPIN-8579).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-chat-column.php
 *
 * Exits 0 when all assertions pass, 1 otherwise. Covers column registration and
 * option sanitisation, host-driven screen opt-in (including the fail-closed
 * default), the chat-page collision guard, asset + config delivery, mount-point
 * rendering, per-user state persistence, and the AJAX state endpoint's
 * authorisation.
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

$GLOBALS['wap_hooks']      = [];
$GLOBALS['wap_styles']     = [];
$GLOBALS['wap_scripts']    = [];
$GLOBALS['wap_localized']  = [];
$GLOBALS['wap_can']        = true;
$GLOBALS['wap_user_meta']  = [];
$GLOBALS['wap_screen']     = null;
$GLOBALS['wap_nonce_ok']   = true;
$GLOBALS['wap_user_id']    = 7;
$GLOBALS['wap_user_exists'] = true;

/** Thrown by the wp_send_json_* shims, which normally terminate the request. */
class WapJsonSent extends \Exception
{
    public bool $success;
    /** @var array<string, mixed> */
    public array $data;
    public int $status;

    public function __construct(bool $success, array $data, int $status)
    {
        parent::__construct('json');
        $this->success = $success;
        $this->data    = $data;
        $this->status  = $status;
    }
}

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

function add_submenu_page(
    string $parent_slug,
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = ''
) {
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

// render_chat_root() consults AppPasswordManager::are_app_passwords_available(),
// which falls back to is_ssl() when wp_is_application_passwords_available()
// isn't defined (as in this suite). Always true here — the Application
// Passwords availability gate itself is covered in test-facade-embed.php.
function is_ssl(): bool
{
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

function wp_kses_post(string $text): string
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
    return $GLOBALS['wap_user_meta'][$user_id][$key] ?? '';
}

function update_user_meta(int $user_id, string $key, $value): bool
{
    $GLOBALS['wap_user_meta'][$user_id][$key] = $value;
    return true;
}

function check_ajax_referer(string $action = '', $query_arg = false, bool $stop = true)
{
    if (!$GLOBALS['wap_nonce_ok']) {
        throw new WapTestDied('bad nonce');
    }
    return 1;
}

function wp_send_json_success(array $data = [], int $status = 200): void
{
    throw new WapJsonSent(true, $data, $status);
}

function wp_send_json_error(array $data = [], int $status = 400): void
{
    throw new WapJsonSent(false, $data, $status);
}

function wp_get_current_user()
{
    return new class {
        public int $ID = 7;
        public string $display_name = 'Ada';
        public string $user_login   = 'ada';

        public function exists(): bool
        {
            return (bool) $GLOBALS['wap_user_exists'];
        }
    };
}

require_once __DIR__ . '/../includes/class-app-password-manager.php';
require_once __DIR__ . '/../includes/class-screen-target.php';
require_once __DIR__ . '/../includes/class-chat-widget.php';
require_once __DIR__ . '/../includes/class-chat-column.php';

use GroupOne\WapClient\ChatColumn;
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
    $GLOBALS['wap_hooks']       = [];
    $GLOBALS['wap_styles']      = [];
    $GLOBALS['wap_scripts']     = [];
    $GLOBALS['wap_localized']   = [];
    $GLOBALS['wap_can']         = true;
    $GLOBALS['wap_user_meta']   = [];
    $GLOBALS['wap_screen']      = null;
    $GLOBALS['wap_nonce_ok']    = true;
    $GLOBALS['wap_user_exists'] = true;
    $GLOBALS['wap_doing_it_wrong'] = [];

    private_prop(ChatWidget::class, 'pages')->setValue(null, []);
    private_prop(ChatWidget::class, 'screen_owner')->setValue(null, '');
    private_prop(ChatColumn::class, 'columns')->setValue(null, []);
    private_prop(ChatColumn::class, 'active')->setValue(null, []);
}

/**
 * @return array<string, mixed> Base column args every case needs.
 */
function column_args(array $overrides = []): array
{
    return array_merge([
        'id'         => 'rocket-assistant',
        'product'    => 'wp-rocket',
        'server_url' => 'https://wap.test',
        'grnd'       => ['issuer_url' => 'https://api.brand.test/grnd', 'license_key' => 'SECRET-LICENSE'],
        'screens'    => ['toplevel_page_wprocket'],
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
 * Register a column and run the enqueue hook for a given screen.
 */
function activate(array $args, string $hook, ?string $screen_id = null): void
{
    ChatColumn::register($args);
    $GLOBALS['wap_screen'] = $screen_id ? screen($screen_id) : null;
    do_action('admin_enqueue_scripts', $hook);
}

function column_record(string $id): array
{
    return private_prop(ChatWidget::class, 'pages')->getValue()[$id] ?? [];
}

function rendered(string $id): string
{
    ob_start();
    ChatColumn::render($id);
    return (string) ob_get_clean();
}

// -----------------------------------------------------------------------------
// Registration + option sanitisation
// -----------------------------------------------------------------------------

echo "\nRegistration and option sanitisation\n";

reset_state();
ChatColumn::register(column_args(['id' => '']));
check('an empty id is rejected', !empty($GLOBALS['wap_doing_it_wrong']));
check('a rejected column registers no surface', [] === private_prop(ChatWidget::class, 'pages')->getValue());

reset_state();
ChatColumn::register(column_args());
$record = column_record('rocket-assistant');
check('the column is stored in the shared widget registry', !empty($record));
check('a column registers no admin menu hook', !has_action('admin_menu'));

$layout = $record['layout'];
check('column layout fills its container', 'fluid' === ($layout['width'] ?? null));
check('column layout fills available height', 'fill' === ($layout['height'] ?? null));
check('column layout drops the card chrome', 'flat' === ($layout['chrome'] ?? null));
check('column layout hides the expand toggle', 'off' === ($layout['expandToggle'] ?? null));

$column = $record['column'];
check('column defaults to the inline-end side', 'right' === ($column['side'] ?? null));
check('column defaults to push mode', 'push' === ($column['mode'] ?? null));
check('column defaults to collapsed', 'collapsed' === ($column['defaultState'] ?? null));
check('column is flagged enabled so cfg.column is not null', true === ($column['enabled'] ?? null));

reset_state();
ChatColumn::register(column_args([
    'column' => ['side' => 'left', 'mode' => 'overlay', 'defaultState' => 'expanded', 'width' => '420px', 'breakpoint' => '800px'],
    'layout' => ['chrome' => 'card'],
]));
$column = column_record('rocket-assistant')['column'];
check('an explicit side wins', 'left' === ($column['side'] ?? null));
check('an explicit mode wins', 'overlay' === ($column['mode'] ?? null));
check('an explicit defaultState wins', 'expanded' === ($column['defaultState'] ?? null));
check('a valid width is kept', '420px' === ($column['width'] ?? null));
check('a valid breakpoint is kept', '800px' === ($column['breakpoint'] ?? null));
check('an explicit layout key beats the column default', 'card' === (column_record('rocket-assistant')['layout']['chrome'] ?? null));

reset_state();
ChatColumn::register(column_args([
    'column' => [
        'side'         => 'diagonal',
        'mode'         => 'float',
        'defaultState' => 'ajar',
        'width'        => 'calc(100% - 10px)',
        'breakpoint'   => 'javascript:alert(1)',
        'bogusKey'     => 'dropped',
    ],
]));
$column = column_record('rocket-assistant')['column'];
check('an unknown side falls back to the default', 'right' === ($column['side'] ?? null));
check('an unknown mode falls back to the default', 'push' === ($column['mode'] ?? null));
check('an unknown defaultState falls back to the default', 'collapsed' === ($column['defaultState'] ?? null));
check('a calc() width is rejected', !array_key_exists('width', $column));
check('a non-length breakpoint is rejected', !array_key_exists('breakpoint', $column));
check('an unknown key is dropped', !array_key_exists('bogusKey', $column));

reset_state();
ChatColumn::register(column_args(['column' => ['showLauncher' => false, 'persist' => false]]));
$column = column_record('rocket-assistant')['column'];
check('showLauncher is coerced to bool', false === ($column['showLauncher'] ?? null));
check('persist is coerced to bool', false === ($column['persist'] ?? null));

reset_state();
ChatColumn::register(column_args());
check('a page surface gets no column config', [] === ChatWidget::surface_column_config('never-registered'));

// -----------------------------------------------------------------------------
// Screen opt-in
// -----------------------------------------------------------------------------

echo "\nScreen opt-in\n";

reset_state();
activate(column_args(), 'toplevel_page_wprocket');
check('a hook-suffix match activates the column', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
activate(column_args(), 'some_other_page');
check('a non-matching screen loads nothing', !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));
check('a non-matching screen renders nothing', '' === trim(rendered('rocket-assistant')));

reset_state();
activate(column_args(['screens' => ['options-general']]), 'options-general.php', 'options-general');
check('a WP_Screen id match activates the column', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
activate(column_args(['screens' => []]), 'toplevel_page_wprocket');
check(
    'no screens and no should_render renders nowhere (fail closed)',
    !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant'])
);

reset_state();
activate(
    column_args([
        'screens'       => [],
        'should_render' => static fn ($screen, string $hook): bool => 0 === strpos($hook, 'toplevel_page_wp'),
    ]),
    'toplevel_page_wprocket'
);
check('should_render can opt a screen in', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
activate(
    column_args(['screens' => [], 'should_render' => static fn (): bool => false]),
    'toplevel_page_wprocket'
);
check('should_render returning false keeps the column off', !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
ChatColumn::register(column_args(['screens' => []]));
add_filter('wap_client_column_screens', static function (array $screens): array {
    $screens[] = 'toplevel_page_wprocket';
    return $screens;
});
do_action('admin_enqueue_scripts', 'toplevel_page_wprocket');
check('the screens filter can opt a screen in per site', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
$seen = [];
activate(
    column_args([
        'screens'       => [],
        'should_render' => static function ($screen, string $hook) use (&$seen): bool {
            $seen = [$screen ? $screen->id : null, $hook];
            return true;
        },
    ]),
    'toplevel_page_wprocket',
    'toplevel_page_wprocket'
);
check('should_render receives the screen and hook', ['toplevel_page_wprocket', 'toplevel_page_wprocket'] === $seen);

// Real hook suffixes and WP_Screen ids carry dots and uppercase — sanitize_key()
// would strip both and the fail-closed default would then hide the column with
// no warning.
reset_state();
activate(column_args(['screens' => ['edit.php']]), 'edit.php', 'edit');
check('a screen id containing a dot still matches', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
activate(column_args(['screens' => ['toplevel_page_MyPlugin']]), 'toplevel_page_MyPlugin');
check('an uppercase hook suffix still matches', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
activate(column_args(['screens' => ['settings_page_acme.settings']]), 'settings_page_acme.settings');
check(
    'a dotted hook suffix still matches',
    isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant'])
);

reset_state();
activate(column_args(['screens' => ['tool<s>_page_x']]), 'tool<s>_page_x');
check(
    'a screen id with unsafe characters is dropped',
    !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant'])
);

// The filter and the direct argument must accept exactly the same set.
reset_state();
ChatColumn::register(column_args(['screens' => []]));
add_filter('wap_client_column_screens', static fn (array $s): array => array_merge($s, ['edit.php']));
do_action('admin_enqueue_scripts', 'edit.php');
check('the screens filter accepts a dotted id too', isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));

reset_state();
ChatColumn::register(column_args(['screens' => []]));
add_filter('wap_client_column_screens', static fn (array $s): array => array_merge($s, ['bad|id']));
do_action('admin_enqueue_scripts', 'bad|id');
check(
    'the screens filter cannot smuggle an unsafe id past sanitisation',
    !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant'])
);

// -----------------------------------------------------------------------------
// Chat-page collision guard
// -----------------------------------------------------------------------------

echo "\nChat-page collision guard\n";

reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
ChatColumn::register(column_args(['screens' => ['toplevel_page_my-plugin-chat']]));
do_action('admin_enqueue_scripts', 'toplevel_page_my-plugin-chat');
check(
    'a column stands down on a registered chat page screen',
    '' === trim(rendered('rocket-assistant'))
);
check(
    'the chat page itself still loads its own assets',
    isset($GLOBALS['wap_scripts']['wap-client-chat-my-plugin-chat'])
);

reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
activate(column_args(), 'toplevel_page_wprocket');
check(
    'a column on an unrelated screen is unaffected by a registered page',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-chat-column')
);

// The guard is a stand-down decision, so it must match the hook exactly (or as
// WordPress's own <parent>_page_<slug> shape) — a substring test would let a
// broad page slug suppress the column across unrelated screens.
reset_state();
ChatWidget::register([
    'menu_slug'  => 'chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
activate(column_args(['screens' => ['toplevel_page_my-chat-plugin']]), 'toplevel_page_my-chat-plugin');
check(
    'a page slug that is merely a substring of the hook does not suppress the column',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-chat-column')
);

reset_state();
ChatWidget::register([
    'menu_slug'  => 'chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
activate(column_args(['screens' => ['settings_page_chat']]), 'settings_page_chat');
check(
    'a submenu hook for a registered page still suppresses the column',
    '' === trim(rendered('rocket-assistant'))
);

// -----------------------------------------------------------------------------
// Capability gate
// -----------------------------------------------------------------------------

echo "\nCapability gate\n";

reset_state();
ChatColumn::register(column_args());
$GLOBALS['wap_can'] = false;
do_action('admin_enqueue_scripts', 'toplevel_page_wprocket');
check('no capability loads no assets', !isset($GLOBALS['wap_scripts']['wap-client-chat-rocket-assistant']));
check('no capability renders no markup', '' === trim(rendered('rocket-assistant')));

reset_state();
activate(column_args(), 'toplevel_page_wprocket');
$GLOBALS['wap_can'] = false;
check('the capability is re-checked at render time', '' === trim(rendered('rocket-assistant')));

// -----------------------------------------------------------------------------
// Config delivery
// -----------------------------------------------------------------------------

echo "\nConfig delivery\n";

reset_state();
activate(column_args(), 'toplevel_page_wprocket');
$localized = $GLOBALS['wap_localized']['wap-client-chat-rocket-assistant'] ?? [];
$widget    = $localized['WapClientConfig'] ?? [];

check('cfg.column reaches the widget', is_object($widget['column'] ?? null));
check('cfg.column carries the side', 'right' === ($widget['column']->side ?? null));
// The explicit JS↔PHP contract: the widget reads the id and state nonce off
// cfg.column instead of rebuilding a global's name from PHP's id mangling.
check('cfg.column carries the column id', 'rocket-assistant' === ($widget['column']->id ?? null));
check('cfg.column carries the state nonce', !empty($widget['column']->stateNonce ?? null));
check('cfg.layout still reaches the widget', 'fluid' === ($widget['layout']->width ?? null));
check('the auth nonce is present', !empty($widget['authNonce']));

$columnGlobal = $localized['WapClientColumn_rocket_assistant'] ?? [];
check('the column localises its own global', !empty($columnGlobal));
check('the column global carries the id', 'rocket-assistant' === ($columnGlobal['id'] ?? null));
check('the column global carries a state nonce', !empty($columnGlobal['stateNonce']));
check('the column global carries the resolved initial state', 'collapsed' === ($columnGlobal['initialState'] ?? null));
check(
    'the column root id is not the widget default',
    'wap-chat-root' !== ($columnGlobal['rootId'] ?? 'wap-chat-root')
);

reset_state();
ChatColumn::register(column_args());
add_filter('wap_client_column', static function (array $column): array {
    $column['side'] = 'left';
    return $column;
});
do_action('admin_enqueue_scripts', 'toplevel_page_wprocket');
$widget = $GLOBALS['wap_localized']['wap-client-chat-rocket-assistant']['WapClientConfig'] ?? [];
check('the wap_client_column filter can retheme the column', 'left' === ($widget['column']->side ?? null));

reset_state();
ChatColumn::register(column_args());
add_filter('wap_client_column', static fn (): array => ['side' => 'sideways', 'mode' => 'push']);
do_action('admin_enqueue_scripts', 'toplevel_page_wprocket');
$widget = $GLOBALS['wap_localized']['wap-client-chat-rocket-assistant']['WapClientConfig'] ?? [];
check(
    'a filter cannot smuggle an invalid value past sanitisation',
    'right' === ($widget['column']->side ?? null)
);

reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
do_action('admin_enqueue_scripts', 'toplevel_page_my-plugin-chat');
$widget = $GLOBALS['wap_localized']['wap-client-chat-my-plugin-chat']['WapClientConfig'] ?? [];
check('a plain page gets cfg.column = null', array_key_exists('column', $widget) && null === $widget['column']);

// -----------------------------------------------------------------------------
// Mount point
// -----------------------------------------------------------------------------

echo "\nMount point\n";

reset_state();
activate(column_args(), 'toplevel_page_wprocket');
$html = rendered('rocket-assistant');

check('the wrapper carries the documented mount-point attribute', false !== strpos($html, 'data-wap-chat-column="rocket-assistant"'));
check('the wrapper carries the server-resolved state', false !== strpos($html, 'data-wap-column-state="collapsed"'));
check('the widget root is nested inside the wrapper', false !== strpos($html, 'wap-chat-root'));
check('the root id is column-specific', false !== strpos($html, 'id="wap-chat-column-root-rocket-assistant"'));
check('the root id is NOT the shared default', false === strpos($html, 'id="wap-chat-root"'));
check('the product is exposed for theming', false !== strpos($html, 'data-product="wp-rocket"'));

check('rendering is idempotent within a request', '' === trim(rendered('rocket-assistant')));

reset_state();
activate(column_args(['product' => 'evil" onload="alert(1)']), 'toplevel_page_wprocket');
$html = rendered('rocket-assistant');
check('the product is escaped into the data attribute', false === strpos($html, 'onload="alert(1)'));

reset_state();
check('render is a no-op for an unregistered column', '' === trim(rendered('never-registered')));

// A chat page and a column on different screens must not collide on DOM ids.
reset_state();
ChatWidget::register([
    'menu_slug'  => 'my-plugin-chat',
    'product'    => 'wp-rocket',
    'server_url' => 'https://wap.test',
]);
ob_start();
ChatWidget::render_chat_root('my-plugin-chat');
$pageHtml = (string) ob_get_clean();
check('a page still renders the historical default root id', false !== strpos($pageHtml, 'id="wap-chat-root"'));

ob_start();
ChatWidget::render_chat_root('my-plugin-chat', 'custom mount!');
$customHtml = (string) ob_get_clean();
check('a custom root id is applied', false !== strpos($customHtml, 'id="custommount"'));
check('a custom root id is sanitised', false === strpos($customHtml, 'custom mount!'));

// -----------------------------------------------------------------------------
// Per-user state
// -----------------------------------------------------------------------------

echo "\nPer-user state\n";

reset_state();
activate(column_args(), 'toplevel_page_wprocket');
check('state defaults to collapsed', false !== strpos(rendered('rocket-assistant'), 'data-wap-column-state="collapsed"'));

reset_state();
$GLOBALS['wap_user_meta'][7]['wap_client_column_rocket-assistant'] = 'expanded';
activate(column_args(), 'toplevel_page_wprocket');
check(
    'a stored preference is applied server-side, so nothing flashes open',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-column-state="expanded"')
);

reset_state();
$GLOBALS['wap_user_meta'][7]['wap_client_column_rocket-assistant'] = 'expanded';
activate(column_args(['column' => ['persist' => false]]), 'toplevel_page_wprocket');
check(
    'persist:false ignores stored meta and uses the default',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-column-state="collapsed"')
);

reset_state();
$GLOBALS['wap_user_meta'][7]['wap_client_column_rocket-assistant'] = 'sideways';
activate(column_args(), 'toplevel_page_wprocket');
check(
    'a corrupt stored value falls back to the default',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-column-state="collapsed"')
);

reset_state();
activate(column_args(['column' => ['defaultState' => 'expanded']]), 'toplevel_page_wprocket');
check(
    'defaultState expanded is honoured with no stored preference',
    false !== strpos(rendered('rocket-assistant'), 'data-wap-column-state="expanded"')
);

// -----------------------------------------------------------------------------
// AJAX state endpoint
// -----------------------------------------------------------------------------

echo "\nAJAX state endpoint\n";

/**
 * @return WapJsonSent|WapTestDied
 */
function call_ajax(array $post)
{
    $_POST = $post;
    try {
        ChatColumn::ajax_state();
    } catch (WapJsonSent $e) {
        return $e;
    } catch (WapTestDied $e) {
        return $e;
    }
    throw new \RuntimeException('ajax_state returned without sending a response');
}

reset_state();
ChatColumn::register(column_args());
$res = call_ajax(['op' => 'get', 'id' => 'rocket-assistant']);
check('get returns the current state', $res instanceof WapJsonSent && $res->success && 'collapsed' === $res->data['state']);

reset_state();
ChatColumn::register(column_args());
$res = call_ajax(['op' => 'set', 'id' => 'rocket-assistant', 'state' => 'expanded']);
check('set stores the state', $res instanceof WapJsonSent && $res->success);
check(
    'set writes user meta under the namespaced key',
    'expanded' === ($GLOBALS['wap_user_meta'][7]['wap_client_column_rocket-assistant'] ?? null)
);

$res = call_ajax(['op' => 'get', 'id' => 'rocket-assistant']);
check('the stored state round-trips', $res instanceof WapJsonSent && 'expanded' === $res->data['state']);

reset_state();
ChatColumn::register(column_args());
$res = call_ajax(['op' => 'set', 'id' => 'rocket-assistant', 'state' => 'sideways']);
check('an invalid state is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);
check('an invalid state writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatColumn::register(column_args());
$res = call_ajax(['op' => 'set', 'id' => 'not-registered', 'state' => 'expanded']);
check('an unregistered id is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);
check('an unregistered id writes no arbitrary meta key', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatColumn::register(column_args());
$res = call_ajax(['op' => 'destroy', 'id' => 'rocket-assistant']);
check('an unknown op is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);

reset_state();
ChatColumn::register(column_args());
$GLOBALS['wap_can'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'rocket-assistant', 'state' => 'expanded']);
check('a user without the capability is rejected', $res instanceof WapJsonSent && !$res->success && 403 === $res->status);
check('a rejected user writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatColumn::register(column_args());
$GLOBALS['wap_nonce_ok'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'rocket-assistant', 'state' => 'expanded']);
check('a bad nonce stops the request before anything is written', $res instanceof WapTestDied);
check('a bad nonce writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatColumn::register(column_args());
$GLOBALS['wap_user_exists'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'rocket-assistant', 'state' => 'expanded']);
check('a logged-out user is rejected', $res instanceof WapJsonSent && !$res->success && 401 === $res->status);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
