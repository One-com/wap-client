<?php
/**
 * Standalone unit tests for per-surface capabilities.
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-surface-capability.php
 *
 * Exits 0 when all assertions pass, 1 otherwise.
 *
 * The scenario is two host plugins on one site, as with WP Rocket and Rank Math:
 * product `rankmath` has a page on manage_options and an inline embed on
 * edit_posts, product `wprocket` has a column on rocket_manage_options, and one
 * plugin still hooks `wap_client_capability` with a callback that ignores which
 * surface it is asked about. Each surface must answer to its own capability for
 * its menu entry, page, assets, mount point and AJAX endpoints, and the auth
 * endpoint must only mint for the product of the surface the request names.
 *
 * Unlike the other suites, current_user_can() here answers per capability, and
 * apply_filters() passes each callback only the arguments it accepts, as
 * WordPress does. Both matter to what is tested.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

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

/** Thrown by wp_die(). */
class WapTestDied extends \Exception
{
}

function add_action(string $hook, $callback, int $priority = 10, int $accepted_args = 1): bool
{
    $GLOBALS['wap_hooks'][$hook][$priority][] = [$callback, $accepted_args];
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
 * A hook's callbacks in priority order, each with the number of arguments it accepts.
 *
 * @return array<int, array{0: callable, 1: int}>
 */
function hooked(string $hook): array
{
    $by_priority = $GLOBALS['wap_hooks'][$hook] ?? [];
    ksort($by_priority);

    return $by_priority ? array_merge(...array_values($by_priority)) : [];
}

function do_action(string $hook, ...$args): void
{
    foreach (hooked($hook) as [$callback, $accepted_args]) {
        $callback(...array_slice($args, 0, $accepted_args));
    }
}

function apply_filters(string $hook, $value, ...$args)
{
    foreach (hooked($hook) as [$callback, $accepted_args]) {
        $value = $callback(...array_slice(array_merge([$value], $args), 0, $accepted_args));
    }
    return $value;
}

/** Per capability. 'do_not_allow' is denied to everyone, as in WordPress. */
function current_user_can(string $capability): bool
{
    return 'do_not_allow' !== $capability && in_array($capability, $GLOBALS['wap_caps'], true);
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
    $hook = ('' === $parent_slug ? 'admin' : str_replace('.php', '', $parent_slug)) . '_page_' . $menu_slug;
    $GLOBALS['wap_menus'][$menu_slug] = $capability;
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
    $GLOBALS['wap_menus'][$menu_slug] = $capability;
    if ($callback) {
        add_action('toplevel_page_' . $menu_slug, $callback);
    }
    return 'toplevel_page_' . $menu_slug;
}

function wp_enqueue_style(string $handle, string $src = '', array $deps = [], $ver = null): void
{
    $GLOBALS['wap_styles'][$handle] = $src;
}

function wp_enqueue_script(string $handle, string $src = '', array $deps = [], $ver = null, bool $in_footer = false): void
{
    $GLOBALS['wap_scripts'][$handle] = $src;
}

function wp_localize_script(string $handle, string $object_name, array $data): bool
{
    $GLOBALS['wap_localized'][$handle][$object_name] = $data;
    return true;
}

// AppPasswordManager::are_app_passwords_available(), reached when a mount point renders.
function is_ssl(): bool
{
    return true;
}

if (!function_exists('is_multisite')) {
    function is_multisite(): bool
    {
        return false;
    }
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

function wp_kses_post(string $text): string
{
    return $text;
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

function delete_transient(string $key): bool
{
    unset($GLOBALS['wap_transients'][$key]);
    return true;
}

function check_ajax_referer(string $action = '', $query_arg = false, bool $stop = true)
{
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

function get_current_user_id(): int
{
    return $GLOBALS['wap_user_exists'] ? 7 : 0;
}

function is_wp_error($thing): bool
{
    return $thing instanceof WP_Error;
}

// wap_client_activate() grants the filtered capability to these roles.
class WP_Role
{
    public string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function add_cap(string $capability): void
    {
        $GLOBALS['wap_role_caps'][$this->name][] = $capability;
    }
}

function get_role(string $role): ?WP_Role
{
    return new WP_Role($role);
}

// The real facade, with GRND acquisition replaced by a recorder.
require_once __DIR__ . '/fixtures/grnd-service-stub.php';
// After this file's own shims, which win. Saving a permission choice takes the user's AppPasswordLock.
require_once __DIR__ . '/fixtures/app-password-shims.php';
require_once __DIR__ . '/../includes/class-app-password-lock.php';
$GLOBALS['wpdb'] = new WapTestAppPasswordWpdb('wap_user_meta');
require_once __DIR__ . '/../includes/class-app-password-manager.php';
require_once __DIR__ . '/../includes/class-screen-target.php';
require_once __DIR__ . '/../includes/class-token-manager.php';
require_once __DIR__ . '/../includes/class-consent-gate.php';
require_once __DIR__ . '/../includes/class-config.php';
\GroupOne\WapClient\Config::configure(['version' => '1.0.0', 'url' => 'https://customer-site.test/wp-content/plugins/my-plugin/vendor/groupone/wap-client/']);
require_once __DIR__ . '/../includes/class-chat-widget.php';
require_once __DIR__ . '/../includes/class-chat-column.php';
require_once __DIR__ . '/../includes/class-chat-embed.php';
require_once __DIR__ . '/../includes/class-gdpr-handler.php';
require_once __DIR__ . '/../includes/class-bootstrap.php';
require_once __DIR__ . '/../includes/class-wap-client.php';
require_once __DIR__ . '/../wap-client-api.php';

use GroupOne\WapClient\ChatColumn;
use GroupOne\WapClient\ChatEmbed;
use GroupOne\WapClient\ChatWidget;
use GroupOne\WapClient\GdprHandler;

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
    $GLOBALS['wap_caps']           = [];
    $GLOBALS['wap_menus']          = [];
    $GLOBALS['wap_styles']         = [];
    $GLOBALS['wap_scripts']        = [];
    $GLOBALS['wap_localized']      = [];
    $GLOBALS['wap_user_meta']      = [];
    $GLOBALS['wap_transients']     = [];
    $GLOBALS['wap_screen']         = null;
    $GLOBALS['wap_user_exists']    = true;
    $GLOBALS['wap_grnd_calls']     = [];
    $GLOBALS['wap_doing_it_wrong'] = [];
    $GLOBALS['wap_role_caps']      = [];

    private_prop(ChatWidget::class, 'pages')->setValue(null, []);
    private_prop(ChatWidget::class, 'screen_owner')->setValue(null, '');
    private_prop(ChatColumn::class, 'columns')->setValue(null, []);
    private_prop(ChatColumn::class, 'active')->setValue(null, []);
    private_prop(ChatEmbed::class, 'embeds')->setValue(null, []);
    private_prop(ChatEmbed::class, 'active')->setValue(null, []);
    private_prop(ChatEmbed::class, 'emitted')->setValue(null, []);
}

const RM_PAGE    = 'rm-assistant';
const RM_EMBED   = 'content-ai';
const WPR_COLUMN = 'wp-rocket-support';

/** A permission row offering allow and deny. */
function row(string $id): array
{
    return [
        'id'           => $id,
        'label'        => 'Row ' . $id,
        'options'      => [['value' => 'allow', 'label' => 'Allow'], ['value' => 'deny', 'label' => 'Deny']],
        'defaultValue' => 'deny',
    ];
}

/** Rank Math's page: admins only, and the only surface declaring the manage-site row. */
function rm_page_args(array $overrides = []): array
{
    return array_merge([
        'menu_slug'   => RM_PAGE,
        'parent_slug' => 'rank-math',
        'product'     => 'rankmath',
        'capability'  => 'manage_options',
        'server_url'  => 'https://wap.test',
        'grnd'        => ['issuer_url' => 'https://rankmath.test/grnd', 'license_key' => 'rm-license'],
        'permissions' => [row('manage-plugin'), row('manage-site')],
    ], $overrides);
}

/** Rank Math's embed in the post editor: same product, open to editors. */
function rm_embed_args(array $overrides = []): array
{
    return array_merge([
        'id'          => RM_EMBED,
        'product'     => 'rankmath',
        'capability'  => 'edit_posts',
        'server_url'  => 'https://wap.test',
        'grnd'        => ['issuer_url' => 'https://rankmath.test/grnd', 'license_key' => 'rm-license'],
        'screens'     => ['post'],
        'permissions' => [row('manage-plugin')],
    ], $overrides);
}

/** WP Rocket's column on its settings screen, on its own capability. */
function wpr_column_args(array $overrides = []): array
{
    return array_merge([
        'id'         => WPR_COLUMN,
        'product'    => 'wprocket',
        'capability' => 'rocket_manage_options',
        'server_url' => 'https://wap.test',
        'grnd'       => ['issuer_url' => 'https://wp-rocket.test/grnd', 'license_key' => 'wpr-license'],
        'screens'    => ['settings_page_wprocket'],
    ], $overrides);
}

/** What each host's wap_client_capability callback returns today, whatever surface it is asked about. */
const HOST_CALLBACKS = [
    'rocket_manage_options' => "WP Rocket's",
    'manage_options'        => "Rank Math's",
];

/**
 * Both products registered, with both hosts' unscoped callbacks hooked. The one
 * that runs last used to decide for both products; $last is what it returns.
 */
function two_plugins(string $last): void
{
    foreach (array_keys(HOST_CALLBACKS) as $capability) {
        if ($capability !== $last) {
            add_filter('wap_client_capability', static fn (): string => $capability);
        }
    }
    add_filter('wap_client_capability', static fn (): string => $last);

    ChatWidget::register(rm_page_args());
    ChatEmbed::register(rm_embed_args());
    ChatColumn::register(wpr_column_args());
}

/** @param string[] $caps The capabilities the current user holds. */
function as_user(array $caps): void
{
    $GLOBALS['wap_caps'] = $caps;
}

/**
 * Invoke an AJAX handler, returning what it threw.
 *
 * @return WapJsonSent|WapTestDied
 */
function call(callable $handler, array $post)
{
    $_POST = $post;
    try {
        $handler();
    } catch (WapJsonSent $sent) {
        return $sent;
    } catch (WapTestDied $died) {
        return $died;
    } finally {
        $_POST = [];
    }
    throw new \RuntimeException('the handler returned without sending a response');
}

function auth(string $menu_slug, string $product)
{
    return call([ChatWidget::class, 'ajax_auth'], ['menu_slug' => $menu_slug, 'product' => $product]);
}

function consent(string $product, string $op = 'grant')
{
    return call([ChatWidget::class, 'ajax_consent'], ['product' => $product, 'op' => $op]);
}

function permission(string $product, string $id)
{
    return call(
        [ChatWidget::class, 'ajax_permission_state'],
        ['op' => 'set', 'product' => $product, 'id' => $id, 'value' => 'allow']
    );
}

function column_state(string $id)
{
    return call([ChatColumn::class, 'ajax_state'], ['op' => 'set', 'id' => $id, 'state' => 'expanded']);
}

function erase()
{
    return call([GdprHandler::class, 'ajax_delete_data'], []);
}

function accepted($res): bool
{
    return $res instanceof WapJsonSent && $res->success;
}

function rejected($res, int $status): bool
{
    return $res instanceof WapJsonSent && !$res->success && $status === $res->status;
}

/** The admin footer's output, where a column renders its mount point. */
function footer(): string
{
    ob_start();
    do_action('admin_footer');
    return (string) ob_get_clean();
}

// -----------------------------------------------------------------------------
// Which capability gates a surface
// -----------------------------------------------------------------------------

echo "Which capability gates a surface\n";

reset_state();
ChatWidget::register(rm_page_args());
as_user(['manage_options', 'edit_posts', 'rocket_manage_options', 'wap_use_ai']);
check('an unregistered surface has no capability', '' === ChatWidget::surface_capability('not-registered'));
check(
    'an unregistered surface is closed even to a user holding every capability',
    !ChatWidget::user_can_use_surface('not-registered')
);

reset_state();
ChatWidget::register(rm_page_args(['capability' => null]));
check('a surface that declares none defaults to wap_use_ai', 'wap_use_ai' === ChatWidget::surface_capability(RM_PAGE));

reset_state();
add_filter('wap_client_capability', static fn (): string => 'rocket_manage_options');
ChatWidget::register(rm_page_args(['capability' => null]));
check(
    'an unscoped callback still decides for a surface that declares none (back-compat)',
    'rocket_manage_options' === ChatWidget::surface_capability(RM_PAGE)
);

reset_state();
$seen = [];
add_filter('wap_client_capability', static function (string $capability, string $product, string $surface) use (&$seen): string {
    $seen[] = [$capability, $product, $surface];
    return 'wprocket' === $product ? 'rocket_manage_options' : $capability;
}, 10, 3);
ChatWidget::register(rm_page_args(['capability' => null]));
ChatColumn::register(wpr_column_args(['capability' => null]));
$rm_capability  = ChatWidget::surface_capability(RM_PAGE);
$wpr_capability = ChatWidget::surface_capability(WPR_COLUMN);
check(
    'the filter receives the default, the product and the surface id',
    in_array(['wap_use_ai', 'rankmath', RM_PAGE], $seen, true)
        && in_array(['wap_use_ai', 'wprocket', WPR_COLUMN], $seen, true)
);
check('a callback scoped by product gates its own surfaces', 'rocket_manage_options' === $wpr_capability);
check('a callback scoped by product leaves other products alone', 'wap_use_ai' === $rm_capability);

reset_state();
add_filter('wap_client_capability', static fn () => null);
ChatWidget::register(rm_page_args(['capability' => null]));
as_user(['wap_use_ai', 'manage_options']);
check('a filter result that is not a string closes the surface', !ChatWidget::user_can_use_surface(RM_PAGE));

foreach (['an array' => ['manage_options'], 'an empty string' => '', 'whitespace' => '  ', 'an integer' => 1] as $label => $value) {
    reset_state();
    ChatWidget::register(rm_page_args(['capability' => $value]));
    as_user(['manage_options', 'wap_use_ai']);
    check(
        "a capability given as {$label} fails closed",
        'do_not_allow' === ChatWidget::surface_capability(RM_PAGE) && !ChatWidget::user_can_use_surface(RM_PAGE)
    );
    check("a capability given as {$label} raises _doing_it_wrong()", 1 === count($GLOBALS['wap_doing_it_wrong']));
}

reset_state();
ChatWidget::register(rm_page_args(['capability' => ' manage_options ']));
check('surrounding whitespace is trimmed', 'manage_options' === ChatWidget::surface_capability(RM_PAGE));
check('a valid capability raises no notice', [] === $GLOBALS['wap_doing_it_wrong']);

// -----------------------------------------------------------------------------
// Two plugins on one site, whichever unscoped callback runs last
// -----------------------------------------------------------------------------

function two_plugin_scenarios(string $last): void
{
    $order = ' (' . HOST_CALLBACKS[$last] . ' callback runs last)';

    echo "\nResolution{$order}\n";

    reset_state();
    two_plugins($last);
    check(
        "a declared capability ignores both hosts' unscoped callbacks",
        'manage_options' === ChatWidget::surface_capability(RM_PAGE)
            && 'edit_posts' === ChatWidget::surface_capability(RM_EMBED)
            && 'rocket_manage_options' === ChatWidget::surface_capability(WPR_COLUMN)
    );

    echo "\nMenu entry, page, assets and mount points{$order}\n";

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    do_action('admin_menu');
    check('a WP Rocket manager gets no Rank Math menu entry', !isset($GLOBALS['wap_menus'][RM_PAGE]));
    do_action('admin_enqueue_scripts', 'rank-math_page_' . RM_PAGE);
    check("nor Rank Math's page assets", !isset($GLOBALS['wap_scripts']['wap-client-chat-' . RM_PAGE]));

    reset_state();
    two_plugins($last);
    as_user(['manage_options']);
    do_action('admin_menu');
    check(
        "the menu entry is registered on the page's own capability",
        'manage_options' === ($GLOBALS['wap_menus'][RM_PAGE] ?? null)
    );
    as_user(['rocket_manage_options']);
    $died = false;
    ob_start();
    try {
        do_action('rank-math_page_' . RM_PAGE);
    } catch (WapTestDied $e) {
        $died = true;
    }
    ob_end_clean();
    check('the page re-checks its own capability before any output', $died);

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    $GLOBALS['wap_screen'] = (object) ['id' => 'settings_page_wprocket'];
    do_action('admin_enqueue_scripts', 'settings_page_wprocket');
    check(
        "a WP Rocket manager gets WP Rocket's column assets",
        isset($GLOBALS['wap_scripts']['wap-client-chat-' . WPR_COLUMN])
    );
    check('and its mount point', false !== strpos(footer(), 'data-wap-chat-column="' . WPR_COLUMN . '"'));

    reset_state();
    two_plugins($last);
    as_user(['manage_options']);
    $GLOBALS['wap_screen'] = (object) ['id' => 'settings_page_wprocket'];
    do_action('admin_enqueue_scripts', 'settings_page_wprocket');
    check(
        "manage_options alone does not load WP Rocket's column",
        !isset($GLOBALS['wap_scripts']['wap-client-chat-' . WPR_COLUMN])
    );
    check('nor render it', '' === trim(footer()));

    reset_state();
    two_plugins($last);
    as_user(['edit_posts']);
    $GLOBALS['wap_screen'] = (object) ['id' => 'post'];
    do_action('admin_enqueue_scripts', 'post.php');
    check(
        'an editor gets the embed of a product whose admin-only page they cannot open',
        ChatEmbed::is_active(RM_EMBED) && '' !== ChatEmbed::get(RM_EMBED)
    );

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    $GLOBALS['wap_screen'] = (object) ['id' => 'post'];
    do_action('admin_enqueue_scripts', 'post.php');
    check(
        "a WP Rocket manager does not get Rank Math's embed",
        !ChatEmbed::is_active(RM_EMBED) && '' === ChatEmbed::get(RM_EMBED)
    );

    echo "\nAuth: the surface decides who may mint, and for which product{$order}\n";

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    check("a WP Rocket manager cannot mint through Rank Math's page", rejected(auth(RM_PAGE, 'rankmath'), 403));
    check('a refused request mints nothing', [] === $GLOBALS['wap_grnd_calls']);

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    $res  = auth(WPR_COLUMN, 'wprocket');
    $call = $GLOBALS['wap_grnd_calls'][0] ?? [];
    check(
        "a WP Rocket manager mints through WP Rocket's column",
        accepted($res) && 'grnd-for-wprocket' === ($res->data['token'] ?? null)
    );
    check(
        "the GRND is requested with that surface's product and credentials",
        'wprocket' === ($call['product'] ?? null)
            && 'https://wp-rocket.test/grnd' === ($call['issuer_url'] ?? null)
            && 'wpr-license' === ($call['license_key'] ?? null)
    );

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    check("a product other than the surface's is rejected", rejected(auth(WPR_COLUMN, 'rankmath'), 400));
    check('a mismatched product mints nothing', [] === $GLOBALS['wap_grnd_calls']);

    reset_state();
    two_plugins($last);
    as_user(['manage_options', 'rocket_manage_options']);
    check(
        'the mismatch is rejected even for a user who may use both products',
        rejected(auth(RM_PAGE, 'wprocket'), 400) && [] === $GLOBALS['wap_grnd_calls']
    );

    reset_state();
    two_plugins($last);
    as_user(['manage_options', 'edit_posts', 'rocket_manage_options']);
    check('an unregistered surface is rejected', rejected(auth('not-registered', 'rankmath'), 400));
    check('an empty product is rejected', rejected(auth(RM_PAGE, ''), 400));
    check('neither mints anything', [] === $GLOBALS['wap_grnd_calls']);

    reset_state();
    two_plugins($last);
    as_user(['edit_posts']);
    check('an editor mints through the embed', accepted(auth(RM_EMBED, 'rankmath')));
    check(
        "an editor cannot mint through the same product's admin-only page",
        rejected(auth(RM_PAGE, 'rankmath'), 403)
    );

    echo "\nConsent: per product, gated by that product's surfaces{$order}\n";

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    check('a WP Rocket manager cannot grant Rank Math consent', rejected(consent('rankmath'), 403));
    check('a refused grant writes nothing', !isset($GLOBALS['wap_user_meta'][7]['wap_client_consent_rankmath']));
    check(
        'a WP Rocket manager can grant WP Rocket consent',
        accepted(consent('wprocket')) && isset($GLOBALS['wap_user_meta'][7]['wap_client_consent_wprocket'])
    );

    reset_state();
    two_plugins($last);
    as_user(['edit_posts']);
    check('one surface of the product the user may use is enough', accepted(consent('rankmath')));

    reset_state();
    two_plugins($last);
    as_user([]);
    check(
        "a user who may use none of the product's surfaces cannot read it",
        rejected(consent('wprocket', 'get'), 403)
    );

    reset_state();
    two_plugins($last);
    as_user(['manage_options', 'edit_posts', 'rocket_manage_options']);
    check('an unregistered product is still rejected', rejected(consent('somebody-else'), 400));

    echo "\nPermissions: a row is gated like the surface that declares it{$order}\n";

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    check(
        'a WP Rocket manager cannot change Rank Math permissions',
        rejected(permission('rankmath', 'manage-plugin'), 403)
    );
    check('a refused write stores nothing', empty($GLOBALS['wap_user_meta'][7]));

    reset_state();
    two_plugins($last);
    as_user(['edit_posts']);
    check('an editor can set a row the embed declares', accepted(permission('rankmath', 'manage-plugin')));
    check(
        'an editor cannot set a row only the admin-only page declares',
        rejected(permission('rankmath', 'manage-site'), 400)
    );
    check(
        'that row keeps its default',
        !isset($GLOBALS['wap_user_meta'][7]['wap_client_permission_rankmath_manage-site'])
    );

    reset_state();
    two_plugins($last);
    as_user(['manage_options']);
    check('an admin can set the page-only row', accepted(permission('rankmath', 'manage-site')));

    echo "\nColumn state: gated by the column the request names{$order}\n";

    reset_state();
    two_plugins($last);
    as_user(['manage_options']);
    check(
        "a user without the column's capability cannot write its state",
        rejected(column_state(WPR_COLUMN), 403)
    );
    check('a refused write stores nothing', empty($GLOBALS['wap_user_meta'][7]));

    reset_state();
    two_plugins($last);
    as_user(['rocket_manage_options']);
    check("a user with the column's capability can", accepted(column_state(WPR_COLUMN)));

    echo "\nDelete my data: any surface the user may use{$order}\n";

    reset_state();
    two_plugins($last);
    as_user([]);
    $GLOBALS['wap_user_meta'][7]['wap_client_consent_wprocket'] = 1;
    check('a user who may use no surface cannot erase', rejected(erase(), 403));
    check('a refused erasure deletes nothing', isset($GLOBALS['wap_user_meta'][7]['wap_client_consent_wprocket']));

    // Logged out below, so a request that passes the capability check stops at
    // the next one instead of running the erasure itself.
    foreach (['rocket_manage_options', 'manage_options', 'edit_posts'] as $capability) {
        reset_state();
        two_plugins($last);
        as_user([$capability]);
        $GLOBALS['wap_user_exists'] = false;
        check("a user who may use a surface on {$capability} gets past the capability check", rejected(erase(), 401));
    }
}

foreach (array_keys(HOST_CALLBACKS) as $last) {
    two_plugin_scenarios($last);
}

// -----------------------------------------------------------------------------
// grnd.send_user_ref: the auth endpoint forwards it, and a failure stays generic
// -----------------------------------------------------------------------------

echo "\nsend_user_ref on the auth endpoint\n";

class WP_Error
{
    private string $code;
    private string $message;

    public function __construct(string $code = '', string $message = '')
    {
        $this->code    = $code;
        $this->message = $message;
    }

    public function get_error_code(): string
    {
        return $this->code;
    }

    public function get_error_message(): string
    {
        return $this->message;
    }
}

foreach ([['on', true], ['off', false]] as [$label, $flag]) {
    reset_state();
    ChatWidget::register(rm_page_args(['grnd' => ['issuer_url' => 'https://rankmath.test/grnd', 'license_key' => 'rm-license', 'send_user_ref' => $flag]]));
    as_user(['manage_options']);
    $res  = auth(RM_PAGE, 'rankmath');
    $call = $GLOBALS['wap_grnd_calls'][0] ?? [];
    check("R2 option {$label}: the minted request carries send_user_ref " . var_export($flag, true), accepted($res) && ($call['send_user_ref'] ?? null) === $flag);
    check(
        "R2 option {$label}: the other arguments are unchanged",
        'rankmath' === ($call['product'] ?? null)
            && 'https://wap.test' === ($call['server_url'] ?? null)
            && 'https://rankmath.test/grnd' === ($call['issuer_url'] ?? null)
            && 'rm-license' === ($call['license_key'] ?? null)
            && false === ($call['force_new'] ?? null)
            && array_key_exists('grnd_provider', $call) && null === $call['grnd_provider']
    );
}

reset_state();
ChatWidget::register(rm_page_args(['grnd' => ['issuer_url' => 'https://rankmath.test/grnd', 'license_key' => 'rm-license', 'send_user_ref' => true]]));
as_user(['manage_options']);
$GLOBALS['wap_grnd_result'] = new WP_Error('wap_user_ref_unavailable', 'The user reference is not available for the exchange.');
$res = auth(RM_PAGE, 'rankmath');
unset($GLOBALS['wap_grnd_result']);
check('R2 wap_user_ref_unavailable is a 403', rejected($res, 403));
check(
    'R2 and the browser gets the generic message, not the code or the reason',
    $res instanceof WapJsonSent
        && ['message'] === array_keys($res->data)
        && false === strpos((string) json_encode($res->data), 'user_ref')
);

// -----------------------------------------------------------------------------
// R3: surfaces of one product that disagree on send_user_ref
// -----------------------------------------------------------------------------

echo "\nsend_user_ref consistency per product\n";

function surface_args(string $slug, string $product, bool $flag): array
{
    return rm_page_args([
        'menu_slug' => $slug,
        'product'   => $product,
        'grnd'      => ['issuer_url' => 'https://rankmath.test/grnd', 'license_key' => 'rm-license', 'send_user_ref' => $flag],
    ]);
}

// WP_DEBUG is a constant: the off case must run before it is defined.
reset_state();
ChatWidget::register(surface_args('surface-a', 'rankmath', true));
ChatWidget::register(surface_args('surface-b', 'rankmath', false));
check('R3 WP_DEBUG off: a disagreement raises no notice', [] === $GLOBALS['wap_doing_it_wrong']);

define('WP_DEBUG', true);

reset_state();
ChatWidget::register(surface_args('surface-a', 'rankmath', true));
ChatWidget::register(surface_args('surface-b', 'rankmath', false));
check('R3 a disagreeing pair raises one notice', 1 === count($GLOBALS['wap_doing_it_wrong']));
check(
    'R3 naming both surfaces and the product',
    false !== strpos($GLOBALS['wap_doing_it_wrong'][0] ?? '', 'surface-a')
        && false !== strpos($GLOBALS['wap_doing_it_wrong'][0] ?? '', 'surface-b')
        && false !== strpos($GLOBALS['wap_doing_it_wrong'][0] ?? '', 'rankmath')
);
check(
    'R3 both surfaces are still registered',
    isset(private_prop(ChatWidget::class, 'pages')->getValue()['surface-a'], private_prop(ChatWidget::class, 'pages')->getValue()['surface-b'])
);

reset_state();
ChatWidget::register(surface_args('surface-a', 'rankmath', true));
ChatWidget::register(surface_args('surface-b', 'rankmath', true));
ChatWidget::register(surface_args('surface-c', 'other-product', false));
check('R3 agreeing flags, and a different product, raise no notice', [] === $GLOBALS['wap_doing_it_wrong']);

reset_state();
ChatWidget::register(surface_args('surface-a', 'rankmath', true));
ChatWidget::register(surface_args('surface-a', 'rankmath', false));
check('R3 re-registering the same surface raises no notice', [] === $GLOBALS['wap_doing_it_wrong']);

// -----------------------------------------------------------------------------
// Activation
// -----------------------------------------------------------------------------

echo "\nActivation\n";

reset_state();
add_filter('wap_client_capability', static function (string $capability, string $product, string $surface): string {
    return '' === $product && '' === $surface ? 'manage_options' : $capability;
}, 10, 3);
$error = null;
try {
    wap_client_activate();
} catch (\ArgumentCountError $e) {
    $error = $e;
}
check('activation passes all three filter arguments, so a three-argument callback runs', null === $error);
check(
    'activation grants the filtered capability',
    ['manage_options'] === ($GLOBALS['wap_role_caps']['administrator'] ?? null)
);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
