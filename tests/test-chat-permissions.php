<?php
/**
 * Standalone unit tests for the settings sheet's Permissions rows (RKM-2081).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-chat-permissions.php
 *
 * Exits 0 when all assertions pass, 1 otherwise. Covers row sanitisation, the
 * localised widget config, the per-user AJAX state endpoint's authorisation and
 * value allowlisting, the GRND cache drop a write performs, and the complete
 * id => value map hosts send to their GRND issuer.
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


// TokenManager::forget() — the GRND cache drop a permission write performs.
function get_transient(string $key)
{
    return $GLOBALS['wap_transients'][$key] ?? false;
}

function set_transient(string $key, $value, int $ttl = 0): bool
{
    $GLOBALS['wap_transients'][$key] = $value;
    return true;
}

function delete_transient(string $key): bool
{
    unset($GLOBALS['wap_transients'][$key]);
    return true;
}

function get_current_user_id(): int
{
    return $GLOBALS['wap_user_exists'] ? 7 : 0;
}

require_once __DIR__ . '/../includes/class-app-password-manager.php';
require_once __DIR__ . '/../includes/class-screen-target.php';
require_once __DIR__ . '/../includes/class-token-manager.php';
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
    $GLOBALS['wap_transients']  = [];

    private_prop(ChatWidget::class, 'pages')->setValue(null, []);
    private_prop(ChatWidget::class, 'screen_owner')->setValue(null, '');
}

/** The two rows RankMath ships (RKM-2007): one real choice, one Deny-only. */
function permission_rows(): array
{
    return [
        [
            'id'           => 'manage-plugin',
            'label'        => 'Manage your Rank Math plugin',
            'options'      => [
                ['value' => 'allow', 'label' => 'Allow'],
                ['value' => 'deny',  'label' => 'Deny'],
            ],
            'defaultValue' => 'deny',
        ],
        [
            'id'           => 'manage-site',
            'label'        => 'Manage your WordPress website',
            'options'      => [['value' => 'deny', 'label' => 'Deny']],
            'defaultValue' => 'deny',
        ],
    ];
}

function page_args(array $overrides = []): array
{
    return array_merge([
        'menu_slug'   => 'rm-assistant',
        'parent_slug' => 'rank-math',
        'product'     => 'rankmath',
        'server_url'  => 'https://wap.test',
        'permissions' => permission_rows(),
    ], $overrides);
}

/** Register a page and return the rows as the widget would receive them. */
function localized_permissions(array $overrides = []): array
{
    ChatWidget::register(page_args($overrides));
    do_action('admin_menu');
    do_action('admin_enqueue_scripts', 'rank-math_page_rm-assistant');

    return $GLOBALS['wap_localized']['wap-client-chat-rm-assistant']['WapClientConfig']['permissions'] ?? [];
}

function localized_config(): array
{
    return $GLOBALS['wap_localized']['wap-client-chat-rm-assistant']['WapClientConfig'] ?? [];
}

/**
 * Invoke the AJAX endpoint, returning whatever it threw (WapJsonSent for a
 * normal response, WapTestDied for a nonce failure).
 */
function call_ajax(array $post)
{
    $_POST = array_merge(['product' => 'rankmath'], $post);
    try {
        ChatWidget::ajax_permission_state();
    } catch (WapJsonSent $sent) {
        return $sent;
    } catch (WapTestDied $died) {
        return $died;
    } finally {
        $_POST = [];
    }
    return null;
}

function meta_key(string $id): string
{
    return 'wap_client_permission_rankmath_' . $id;
}

// -----------------------------------------------------------------------------
// Sanitisation
// -----------------------------------------------------------------------------

reset_state();
$rows = localized_permissions();
check('both well-formed rows survive sanitisation', count($rows) === 2);
check('the row keeps its id and label', ($rows[0]['id'] ?? '') === 'manage-plugin'
    && ($rows[0]['label'] ?? '') === 'Manage your Rank Math plugin');
check('options are preserved in order', ($rows[0]['options'][0]['value'] ?? '') === 'allow'
    && ($rows[0]['options'][1]['value'] ?? '') === 'deny');
check('defaultValue is preserved', ($rows[0]['defaultValue'] ?? '') === 'deny');
check('disabled defaults to false', ($rows[0]['disabled'] ?? null) === false);

reset_state();
$rows = localized_permissions(['permissions' => [array_merge(permission_rows()[0], [
    'onclick'  => 'alert(1)',
    'callback' => 'phpinfo',
])]]);
check('unknown row keys are dropped', count($rows) === 1
    && array_keys($rows[0]) === ['id', 'label', 'options', 'defaultValue', 'disabled', 'hint']);

reset_state();
$rows = localized_permissions(['permissions' => [
    array_merge(permission_rows()[0], ['defaultValue' => 'maybe']),
]]);
check('a defaultValue outside the row options drops the row', $rows === []);

reset_state();
$rows = localized_permissions(['permissions' => [
    array_merge(permission_rows()[0], ['id' => 'Manage-Plugin']),
    array_merge(permission_rows()[0], ['id' => 'manage_plugin']),
    array_merge(permission_rows()[0], ['id' => 'manage plugin']),
]]);
check('ids outside [a-z0-9-] are rejected rather than rewritten', $rows === []);

reset_state();
$many = [];
for ($i = 0; $i < 14; $i++) {
    $many[] = array_merge(permission_rows()[0], ['id' => 'row-' . $i]);
}
$rows = localized_permissions(['permissions' => $many]);
check('rows are capped at 10', count($rows) === 10);
check('the cap keeps the first rows', ($rows[0]['id'] ?? '') === 'row-0' && ($rows[9]['id'] ?? '') === 'row-9');

reset_state();
$rows = localized_permissions(['permissions' => [
    array_merge(permission_rows()[0], ['label' => '<script>alert(1)</script>Manage']),
]]);
check('labels are stripped of markup', ($rows[0]['label'] ?? '') === 'alert(1)Manage');

reset_state();
$rows = localized_permissions(['permissions' => [
    array_merge(permission_rows()[0], ['label' => 'First wins']),
    array_merge(permission_rows()[0], ['label' => 'Second loses']),
]]);
check('a duplicate id keeps the first row only', count($rows) === 1 && ($rows[0]['label'] ?? '') === 'First wins');

reset_state();
check('a non-array permissions value yields no rows', localized_permissions(['permissions' => 'nope']) === []);

reset_state();
$rows = localized_permissions(['permissions' => [
    array_merge(permission_rows()[0], ['options' => [['value' => 'allow']]]),
    array_merge(permission_rows()[0], ['id' => 'other', 'options' => []]),
]]);
check('rows whose options are all malformed are dropped', $rows === []);

reset_state();
$rows = localized_permissions(['permissions' => [array_merge(permission_rows()[0], ['hint' => 'Lets it edit settings'])]]);
check('a hint survives sanitisation', ($rows[0]['hint'] ?? '') === 'Lets it edit settings');

// -----------------------------------------------------------------------------
// Localised config
// -----------------------------------------------------------------------------

reset_state();
localized_permissions();
check('the permission nonce is localised', (localized_config()['permissionNonce'] ?? '') === 'nonce-wap_client_permission_state');

reset_state();
ChatWidget::register(page_args(['permissions' => []]));
add_filter('wap_client_permissions', static fn (array $rows): array => permission_rows());
do_action('admin_menu');
do_action('admin_enqueue_scripts', 'rank-math_page_rm-assistant');
check('the wap_client_permissions filter can add rows', count(localized_config()['permissions'] ?? []) === 2);

reset_state();
ChatWidget::register(page_args());
add_filter('wap_client_permissions', static fn (array $rows): array => array_merge($rows, [
    ['id' => 'BAD ID', 'label' => 'Smuggled', 'options' => [['value' => 'a', 'label' => 'A']], 'defaultValue' => 'a'],
]));
do_action('admin_menu');
do_action('admin_enqueue_scripts', 'rank-math_page_rm-assistant');
check('the filter output is re-sanitised', count(localized_config()['permissions'] ?? []) === 2);

// -----------------------------------------------------------------------------
// AJAX state endpoint
// -----------------------------------------------------------------------------

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'get', 'id' => 'manage-plugin']);
check('an unset permission reads as its default', $res instanceof WapJsonSent && $res->success
    && 'deny' === ($res->data['value'] ?? ''));

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow']);
check('a valid write is accepted', $res instanceof WapJsonSent && $res->success && 'allow' === ($res->data['value'] ?? ''));
check('the value lands in per-user meta', ($GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] ?? '') === 'allow');
$res = call_ajax(['op' => 'get', 'id' => 'manage-plugin']);
check('the stored value reads back', $res instanceof WapJsonSent && 'allow' === ($res->data['value'] ?? ''));

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_transients']['wap_grnd_7_rankmath'] = ['grnd' => 'jwt', 'expires_at' => PHP_INT_MAX];
call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow']);
check(
    'a write drops the cached GRND so the next mint carries the new claim',
    !isset($GLOBALS['wap_transients']['wap_grnd_7_rankmath'])
);

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'maybe']);
check('a value the row does not offer is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);
check('a rejected value writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'set', 'id' => 'manage-site', 'value' => 'allow']);
check(
    'a Deny-only row cannot be set to a value it never offered',
    $res instanceof WapJsonSent && !$res->success && 400 === $res->status
);

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'set', 'id' => 'unregistered', 'value' => 'allow']);
check('an unregistered id is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);
check('an unregistered id writes no meta', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'destroy', 'id' => 'manage-plugin']);
check('an unknown op is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);

reset_state();
ChatWidget::register(page_args());
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow', 'product' => 'somebody-else']);
check('a product with no registered rows is rejected', $res instanceof WapJsonSent && !$res->success && 400 === $res->status);

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_can'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow']);
check('a user without the capability is rejected', $res instanceof WapJsonSent && !$res->success && 403 === $res->status);
check('a rejected user writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_nonce_ok'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow']);
check('a bad nonce stops the request before anything is written', $res instanceof WapTestDied);
check('a bad nonce writes nothing', empty($GLOBALS['wap_user_meta'][7]));

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_user_exists'] = false;
$res = call_ajax(['op' => 'set', 'id' => 'manage-plugin', 'value' => 'allow']);
check('a logged-out user is rejected', $res instanceof WapJsonSent && !$res->success && 401 === $res->status);

// -----------------------------------------------------------------------------
// permissions_for() — what a host sends to its GRND issuer
// -----------------------------------------------------------------------------

reset_state();
ChatWidget::register(page_args());
check(
    'every registered permission is reported, defaulted',
    ChatWidget::permissions_for('rankmath') === ['manage-plugin' => 'deny', 'manage-site' => 'deny']
);

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] = 'allow';
check(
    'a stored choice is reported',
    ChatWidget::permissions_for('rankmath') === ['manage-plugin' => 'allow', 'manage-site' => 'deny']
);

reset_state();
ChatWidget::register(page_args());
$GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] = 'allow';
check(
    'an explicit user id is honoured instead of the current user',
    ChatWidget::permissions_for('rankmath', 7) === ['manage-plugin' => 'allow', 'manage-site' => 'deny']
);

reset_state();
ChatWidget::register(page_args(['permissions' => [[
    'id'           => 'manage-plugin',
    'label'        => 'Manage your Rank Math plugin',
    'options'      => [['value' => 'deny', 'label' => 'Deny']],
    'defaultValue' => 'deny',
]]]));
$GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] = 'allow';
check(
    'narrowing a row revokes a grant that is no longer on the menu',
    ChatWidget::permissions_for('rankmath') === ['manage-plugin' => 'deny']
);

reset_state();
check('an unknown product reports nothing', ChatWidget::permissions_for('nope') === []);

// -----------------------------------------------------------------------------
// GDPR erasure keeps permission choices
// -----------------------------------------------------------------------------

function delete_user_meta(int $user_id, string $key): bool
{
    unset($GLOBALS['wap_user_meta'][$user_id][$key]);
    return true;
}

/** Just enough of $wpdb for GdprHandler's prefix sweeps over the in-memory user meta. */
$GLOBALS['wpdb'] = new class {
    public string $usermeta = 'wp_usermeta';

    public function esc_like(string $text): string
    {
        return $text;
    }

    public function prepare(string $query, ...$args): array
    {
        return $args;
    }

    public function get_col(array $prepared): array
    {
        [$user_id, $like] = $prepared;
        $prefix = rtrim($like, '%');
        return array_values(array_filter(
            array_keys($GLOBALS['wap_user_meta'][$user_id] ?? []),
            static fn (string $key): bool => strpos($key, $prefix) === 0
        ));
    }
};

require_once __DIR__ . '/../includes/class-gdpr-handler.php';

reset_state();
$GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] = 'deny';
$GLOBALS['wap_user_meta'][7]['wap_client_consent_rankmath'] = '1';
\GroupOne\WapClient\GdprHandler::purge_local_state(7);
check(
    'deleting my data keeps a Deny choice instead of reverting it to the default',
    ($GLOBALS['wap_user_meta'][7][meta_key('manage-plugin')] ?? null) === 'deny'
);
check('deleting my data still drops consent', !isset($GLOBALS['wap_user_meta'][7]['wap_client_consent_rankmath']));

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
