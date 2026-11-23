<?php
/**
 * Standalone test: the wp_ajax_wap_client_* actions with two copies of the library on one site.
 *
 * Each copy (a namespace-prefixed one, e.g. via Mozart) registers the same actions. Only the copy that
 * registered the surface may answer; a request nobody owns still gets the handler's usual error.
 *
 * Run directly: php tests/test-ajax-routing.php
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');
$GLOBALS['wap_prio'] = [];
$GLOBALS['wap_current_action'] = '';
require __DIR__ . '/fixtures/app-password-shims.php';

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
    $GLOBALS['wap_prio'][$hook][] = [$priority, count($GLOBALS['wap_hooks'][$hook]) - 1];
    return true;
}

function current_action(): string
{
    return $GLOBALS['wap_current_action'];
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
    // $GLOBALS['wap_caps'], when set, lists the capabilities the user has; otherwise wap_can decides for all.
    return isset($GLOBALS['wap_caps']) ? in_array($capability, $GLOBALS['wap_caps'], true) : (bool) $GLOBALS['wap_can'];
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
require_once __DIR__ . '/../includes/class-config.php';
\GroupOne\WapClient\Config::configure(['version' => '1.0.0', 'url' => 'https://customer-site.test/wp-content/plugins/my-plugin/vendor/groupone/wap-client/']);
require_once __DIR__ . '/../includes/class-chat-widget.php';
require_once __DIR__ . '/../includes/class-chat-column.php';
require_once __DIR__ . '/../includes/class-gdpr-handler.php';
require_once __DIR__ . '/../includes/class-app-password-scope-enforcer.php';
require_once __DIR__ . '/../includes/class-bootstrap.php';


// Second copy: the same class files under another namespace, like a prefixed bundle.
foreach (['config', 'app-password-manager', 'screen-target', 'chat-widget', 'chat-column', 'gdpr-handler', 'app-password-scope-enforcer', 'bootstrap'] as $f) {
    $src = (string) file_get_contents(__DIR__ . '/../includes/class-' . $f . '.php');
    $src = str_replace('namespace GroupOne\\WapClient;', 'namespace Prefix\\GroupOne\\WapClient;', $src);
    eval('?>' . $src);
}

// The erasure runs under the user's lock; a double records which copy ran it instead of touching the database.
foreach (['GroupOne\\WapClient', 'Prefix\\GroupOne\\WapClient'] as $ns) {
    eval('namespace ' . $ns . '; class AppPasswordLock { public static array $ran = []; '
        . 'public static function run(int $id, callable $fn) { self::$ran[] = __NAMESPACE__; return null; } }');
}

use GroupOne\WapClient\Bootstrap as A;
use GroupOne\WapClient\ChatColumn as ColA;
use GroupOne\WapClient\ChatWidget as WidgetA;
use Prefix\GroupOne\WapClient\Bootstrap as B;
use Prefix\GroupOne\WapClient\ChatColumn as ColB;
use Prefix\GroupOne\WapClient\ChatWidget as WidgetB;

$failures = 0;
function check(string $name, bool $condition): void
{
    global $failures;
    echo ($condition ? '  ok  ' : 'FAIL  ') . $name . "\n";
    $failures += $condition ? 0 : 1;
}

/** Fire an action the way WordPress does: callbacks by priority, then registration order. */
function fire(string $action, array $post): ?WapJsonSent
{
    $_POST = $post;
    $GLOBALS['wap_current_action'] = 'wp_ajax_' . $action;
    $entries = $GLOBALS['wap_prio']['wp_ajax_' . $action] ?? [];
    usort($entries, static fn($x, $y) => [$x[0], $x[1]] <=> [$y[0], $y[1]]);
    try {
        foreach ($entries as [, $i]) {
            ($GLOBALS['wap_hooks']['wp_ajax_' . $action][$i])();
        }
    } catch (WapJsonSent $sent) {
        return $sent;
    }
    return null; // WordPress would wp_die('0').
}

// Copy A (registered first, so it answers first) and copy B each own one column of a different product.
ColA::register(['id' => 'rocket', 'product' => 'wp-rocket', 'server_url' => 'https://wap.test', 'grnd' => ['issuer_url' => 'https://a.test/g'], 'screens' => ['x']]);
ColB::register(['id' => 'rank', 'product' => 'rankmath', 'server_url' => 'https://wap.test', 'grnd' => ['issuer_url' => 'https://b.test/g'], 'screens' => ['x']]);
// An older copy of the library (no routing) registers its handler directly at priority 10, before ours.
final class LegacyCopy
{
    public static function auth(): void
    {
        wp_send_json_error(['message' => 'Invalid request parameters.'], 400);
    }
}
add_action('wp_ajax_wap_client_auth', [LegacyCopy::class, 'auth']);
A::boot();
B::boot();

$r = fire('wap_client_column_state', ['op' => 'get', 'id' => 'rank']);
check("B's column state request is answered by B, not rejected by A", null !== $r && $r->success);

$r = fire('wap_client_column_state', ['op' => 'set', 'id' => 'rank', 'state' => 'collapsed']);
check("B's column state can be written", null !== $r && $r->success && 'collapsed' === $r->data['state']);

$r = fire('wap_client_column_state', ['op' => 'get', 'id' => 'rocket']);
check("A's column state request is still answered by A", null !== $r && $r->success);

$r = fire('wap_client_column_state', ['op' => 'get', 'id' => 'nobody']);
check('an id no copy registered still gets the 400', null !== $r && !$r->success && 400 === $r->status);

$r = fire('wap_client_auth', ['menu_slug' => 'nobody', 'product' => 'x']);
check('an unknown auth surface still gets the 400', null !== $r && !$r->success && 400 === $r->status);

$r = fire('wap_client_consent', ['op' => 'grant', 'product' => 'rankmath']);
check("B's product consent is recorded by B", null !== $r && $r->success);
check('and stored under the shared consent meta key', isset($GLOBALS['wap_user_meta'][7]['wap_client_consent_rankmath']));

$r = fire('wap_client_consent', ['op' => 'grant', 'product' => 'unknown']);
check('consent for a product no copy registered still gets the 400', null !== $r && !$r->success && 400 === $r->status);

// The auth request reaches the owning copy: B's page, with the capability denied, is B's 403 (A would say 400).
$GLOBALS['wap_can'] = false;
$r = fire('wap_client_auth', ['menu_slug' => 'rank', 'product' => 'rankmath']);
check("an auth request for B's surface is judged by B (403, not A's 400)", null !== $r && 403 === $r->status);
$GLOBALS['wap_can'] = true;

$GLOBALS['wap_can'] = false;
$r = fire('wap_client_auth', ['menu_slug' => 'rank', 'product' => 'rankmath']);
check("a routing copy answers its own request before an older copy's direct handler", null !== $r && 403 === $r->status);
$GLOBALS['wap_can'] = true;

// A single copy's boot() hooks the router early and the fallback last, on all five actions.
$expected = ['dispatch_ajax' => 1, 'fallback_ajax' => 99];
foreach (['wap_client_auth', 'wap_client_delete_data', 'wap_client_consent', 'wap_client_column_state', 'wap_client_permission_state'] as $action) {
    $found = [];
    foreach ($GLOBALS['wap_hooks']['wp_ajax_' . $action] as $i => $callback) {
        if (is_array($callback) && A::class === $callback[0]) {
            $found[$callback[1]] = $GLOBALS['wap_prio']['wp_ajax_' . $action][$i][0];
        }
    }
    check("boot() routes {$action} at priority 1 and falls back at 99", $expected === $found);
}

// delete_data has no surface of its own: the copy whose surface the user may use runs it, the other does not.
ColA::register(['id' => 'only-a', 'product' => 'prod-a', 'capability' => 'cap_a', 'server_url' => 'https://wap.test', 'grnd' => ['issuer_url' => 'https://a.test/g'], 'screens' => ['x']]);
ColB::register(['id' => 'only-b', 'product' => 'prod-b', 'capability' => 'cap_b', 'server_url' => 'https://wap.test', 'grnd' => ['issuer_url' => 'https://b.test/g'], 'screens' => ['x']]);

$GLOBALS['wap_caps'] = ['cap_b'];
$r = fire('wap_client_delete_data', []);
check('delete_data for a user who may use only copy B surfaces is answered', null !== $r && $r->success);
check('and it ran in copy B only', ['Prefix\\GroupOne\\WapClient'] === \Prefix\GroupOne\WapClient\AppPasswordLock::$ran && [] === \GroupOne\WapClient\AppPasswordLock::$ran);

\Prefix\GroupOne\WapClient\AppPasswordLock::$ran = [];
$GLOBALS['wap_caps'] = ['cap_a'];
$r = fire('wap_client_delete_data', []);
check('and for a user who may use only copy A surfaces it ran in copy A only', null !== $r && $r->success && ['GroupOne\\WapClient'] === \GroupOne\WapClient\AppPasswordLock::$ran && [] === \Prefix\GroupOne\WapClient\AppPasswordLock::$ran);
unset($GLOBALS['wap_caps']);

// delete_data has no surface of its own; with no usable surface in any copy it is the handler's 403, once.
$GLOBALS['wap_can'] = false;
$r = fire('wap_client_delete_data', []);
check('delete_data with no usable surface in any copy is the usual 403', null !== $r && 403 === $r->status);
$GLOBALS['wap_can'] = true;

echo $failures ? "\n{$failures} failed.\n" : "\nAll tests passed.\n";
exit($failures ? 1 : 0);
