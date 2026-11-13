<?php
/**
 * Standalone unit tests for AppPasswordScopeEnforcer (RKM-2014).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-app-password-scope-enforcer.php
 *
 * Exercises the wp_authenticate_application_password_errors callback directly
 * (check()) rather than a real authentication — this is a pure function of
 * ($error, the matched user and password item, the current route, the site's
 * configured MCP endpoint), all of which are shimmed/seeded per case.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

define('ABSPATH', '/');
require __DIR__ . '/fixtures/app-password-shims.php';
define('HOUR_IN_SECONDS', 3600);
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['wap_test_user_meta']       = [];
$GLOBALS['wap_test_application_pws'] = [];
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/mcp/mcp-adapter-default-server';

function get_user_meta(int $user_id, string $key, bool $single = false)
{
    return $GLOBALS['wap_test_user_meta'][$user_id][$key] ?? '';
}

function update_user_meta(int $user_id, string $key, $value): bool
{
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = $value;
    return true;
}

function sanitize_key(string $key): string
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower($key));
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

function is_wp_error($thing): bool
{
    return $thing instanceof WP_Error;
}

class WP_Error
{
    private array $errors = [];

    public function __construct(string $code = '', string $message = '', $data = null)
    {
        if ('' !== $code) {
            $this->add($code, $message, $data);
        }
    }

    public function add(string $code, string $message, $data = null): void
    {
        $this->errors[] = ['code' => $code, 'message' => $message, 'data' => is_array($data) ? $data : []];
    }

    public function has_errors(): bool
    {
        return [] !== $this->errors;
    }

    public function count(): int
    {
        return count($this->errors);
    }

    public function get_error_code(): string
    {
        return $this->errors[0]['code'] ?? '';
    }

    public function get_error_data()
    {
        return $this->errors[0]['data'] ?? [];
    }
}

class WP_User
{
    public int $ID = 0;
}

function wap_test_user(int $id): WP_User
{
    $user = new WP_User();
    $user->ID = $id;
    return $user;
}

// Mirrors WP_Application_Passwords::get_user_application_password(), same shim shape as test-app-password-guard.php.
class WP_Application_Passwords
{
    public static function get_user_application_password(int $user_id, string $uuid): ?array
    {
        foreach ($GLOBALS['wap_test_application_pws'][$user_id] ?? [] as $item) {
            if ($item['uuid'] === $uuid) {
                return $item;
            }
        }
        return null;
    }
}

function wap_test_seed_password(int $user_id, string $uuid, int $created): void
{
    $GLOBALS['wap_test_application_pws'][$user_id][] = ['uuid' => $uuid, 'created' => $created];
}

// In-memory $wpdb over the user-meta store above (tests/fixtures/app-password-shims.php).
$GLOBALS['wpdb'] = new WapTestAppPasswordWpdb('wap_test_user_meta');

// --- wp_authenticate_application_password_errors pipeline shims --------------

function add_action(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    // check() is called directly below; this just records what register() wires.
    $GLOBALS['wap_test_actions'][$hook][] = ['callback' => $callback, 'priority' => $priority, 'args' => $args];
    return true;
}

function untrailingslashit(string $s): string
{
    return rtrim($s, '/');
}

function wp_parse_url(string $url, int $component = -1)
{
    return parse_url($url, $component);
}

function rest_get_url_prefix(): string
{
    return 'wp-json';
}

// Namespaced stand-in for ChatWidget; kept in its own file since this script isn't itself namespaced.
require __DIR__ . '/fixtures/chat-widget-stub.php';

require __DIR__ . '/../includes/class-app-password-guard.php';
require __DIR__ . '/../includes/class-app-password-manager.php';
require __DIR__ . '/../includes/class-app-password-scope-enforcer.php';

use GroupOne\WapClient\AppPasswordManager;
use GroupOne\WapClient\AppPasswordScopeEnforcer;

// -----------------------------------------------------------------------------
// Test helpers
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

function reset_state(): void
{
    $GLOBALS['wap_test_user_meta']       = [];
    $GLOBALS['wap_test_application_pws'] = [];
    $GLOBALS['wap_test_actions']         = [];
    $GLOBALS['wp']                       = new stdClass();
    $GLOBALS['wp']->query_vars           = [];
}

function set_route(string $route): void
{
    $GLOBALS['wp']->query_vars['rest_route'] = $route;
}

// Seeds a WAP-minted password for $user_id (unless $wap is false) and returns core's matched item.
function seed(int $user_id, string $uuid, int $created, bool $wap = true): array
{
    if ($wap) {
        update_user_meta($user_id, 'wap_app_password_uuid_wp-rocket', $uuid);
    }
    wap_test_seed_password($user_id, $uuid, $created);

    return ['uuid' => $uuid, 'created' => $created];
}

// Runs check() the way core's wp_authenticate_application_password() does and returns $error.
function authenticate(int $user_id, array $item, ?WP_Error $error = null): WP_Error
{
    $error = $error ?? new WP_Error();
    AppPasswordScopeEnforcer::check($error, wap_test_user($user_id), $item);

    return $error;
}

// -----------------------------------------------------------------------------
// 1. Registration
// -----------------------------------------------------------------------------

echo "registration\n";

reset_state();
AppPasswordScopeEnforcer::register();
$hooked = $GLOBALS['wap_test_actions']['wp_authenticate_application_password_errors'][0] ?? null;
check('check() is hooked on wp_authenticate_application_password_errors', null !== $hooked && $hooked['callback'] === [AppPasswordScopeEnforcer::class, 'check']);
check('only 3 args are accepted, so the raw password is never passed in', 3 === ($hooked['args'] ?? null));

// -----------------------------------------------------------------------------
// 2. Not a REST request (XML-RPC). Runs before REST_REQUEST is defined below,
//    since a constant can't be undefined again within this script.
// -----------------------------------------------------------------------------

echo "not a REST request (XML-RPC)\n";

reset_state();
$item = seed(11, 'uuid-fresh', time());
set_route('/mcp/mcp-adapter-default-server'); // even a matching route var must not count outside REST.
$error = authenticate(11, $item);
check('a fresh WAP password outside REST is refused', $error->has_errors());
check('the refusal code is wap_app_password_scope', $error->get_error_code() === 'wap_app_password_scope');

reset_state();
$item = seed(12, 'uuid-not-wap', time(), false);
$error = authenticate(12, $item);
check('a non-WAP password outside REST is left alone', !$error->has_errors());

define('REST_REQUEST', true);

// -----------------------------------------------------------------------------
// 3. Another check already refused the password — leave it alone
// -----------------------------------------------------------------------------

echo "earlier refusal\n";

reset_state();
$item  = seed(13, 'uuid-fresh', time());
set_route('/wp/v2/users/me');
$error = authenticate(13, $item, new WP_Error('some_other_error', 'nope'));
check('an existing error is left as the only one', 1 === $error->count() && $error->get_error_code() === 'some_other_error');

// -----------------------------------------------------------------------------
// 4. Application password matched, but not one WAP minted — passthrough
// -----------------------------------------------------------------------------

echo "non-WAP application password\n";

reset_state();
$item = seed(42, 'uuid-not-wap', time(), false);
set_route('/wp/v2/users/me');
$error = authenticate(42, $item);
check('a non-WAP application password is left alone', !$error->has_errors());

// -----------------------------------------------------------------------------
// 5. WAP password, expired
// -----------------------------------------------------------------------------

echo "expired WAP password\n";

reset_state();
$item = seed(7, 'uuid-old', time() - 3601);
set_route('/mcp/mcp-adapter-default-server');

$error = authenticate(7, $item);
check('an expired WAP password is refused', $error->has_errors());
check('the refusal code is wap_app_password_expired', $error->get_error_code() === 'wap_app_password_expired');
check('the refusal status is 401', ($error->get_error_data()['status'] ?? null) === 401);

// -----------------------------------------------------------------------------
// 6. WAP password, fresh, wrong route
// -----------------------------------------------------------------------------

echo "fresh WAP password, wrong route\n";

reset_state();
$item = seed(8, 'uuid-fresh', time());
set_route('/wp/v2/users/me');

$error = authenticate(8, $item);
check('a fresh WAP password on the wrong route is refused', $error->has_errors());
check('the refusal code is wap_app_password_scope', $error->get_error_code() === 'wap_app_password_scope');
check('the refusal status is 403', ($error->get_error_data()['status'] ?? null) === 403);

// -----------------------------------------------------------------------------
// 7. WAP password, fresh, correct route — passthrough
// -----------------------------------------------------------------------------

echo "fresh WAP password, correct route\n";

reset_state();
$item = seed(9, 'uuid-fresh', time());
set_route('/mcp/mcp-adapter-default-server');

$error = authenticate(9, $item);
check('a fresh WAP password on the MCP route is accepted', !$error->has_errors());

// -----------------------------------------------------------------------------
// 8. A host that overrides wap_client_mcp_endpoint to a non-default path
// -----------------------------------------------------------------------------

echo "overridden MCP endpoint\n";

reset_state();
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/custom/v1/mcp';
$item = seed(10, 'uuid-fresh', time());

set_route('/custom/v1/mcp');
check('the overridden MCP route is accepted', !authenticate(10, $item)->has_errors());

set_route('/mcp/mcp-adapter-default-server'); // the DEFAULT path, now stale for this site.
check('the old default path is refused once the endpoint is overridden', authenticate(10, $item)->has_errors());

$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/mcp/mcp-adapter-default-server'; // restore default.

// -----------------------------------------------------------------------------
// 9. A WAP password that is not this site's current one — refused everywhere
//    (a rotation replaced it and a concurrent write restored it, or another
//    site of the network minted it)
// -----------------------------------------------------------------------------

echo "WAP password not on record\n";

reset_state();
set_route('/mcp/mcp-adapter-default-server');
$error = authenticate(20, ['uuid' => 'uuid-restored', 'app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – WP Rocket', 'created' => time()]);
check('a tagged password nobody has on record is refused, even on the MCP route', $error->has_errors());
check('the refusal code is wap_app_password_revoked', $error->get_error_code() === 'wap_app_password_revoked');
check('the refusal status is 401', ($error->get_error_data()['status'] ?? null) === 401);

reset_state();
set_route('/wp/v2/users/me');
$error = authenticate(21, ['uuid' => 'uuid-old-release', 'app_id' => '', 'name' => 'WAP – wprocket', 'created' => time() - 86400]);
check('so is an untracked "WAP – " password from a release before the tag', $error->get_error_code() === 'wap_app_password_revoked');

reset_state();
set_route('/wp/v2/users/me');
$error = authenticate(22, ['uuid' => 'uuid-mine', 'app_id' => '', 'name' => 'WAPITI sync', 'created' => time()]);
check("an untracked password that is not WAP's is still left alone", !$error->has_errors());

// -----------------------------------------------------------------------------
// 10. Multisite: each site accepts only its own password
// -----------------------------------------------------------------------------

echo "multisite\n";

reset_state();
$GLOBALS['wap_test_multisite']    = true;
$GLOBALS['wap_test_blog_id']      = 2;
$GLOBALS['wap_test_home_url']     = 'https://example.test/site2';
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/site2/wp-json/mcp/mcp-adapter-default-server';
update_user_meta(30, 'wap_app_password_uuid_wp-rocket@2', 'uuid-site-2');
update_user_meta(30, 'wap_app_password_uuid_wp-rocket@3', 'uuid-site-3');
$site_2 = ['uuid' => 'uuid-site-2', 'app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – WP Rocket', 'created' => time()];
$site_3 = ['uuid' => 'uuid-site-3', 'app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – WP Rocket', 'created' => time()];

set_route('/mcp/mcp-adapter-default-server');
check("site 2's password works on site 2's MCP endpoint (a subdirectory subsite)", !authenticate(30, $site_2)->has_errors());
check("site 3's password is refused on site 2", authenticate(30, $site_3)->get_error_code() === 'wap_app_password_revoked');
set_route('/wp/v2/settings');
check("site 2's own password is still MCP-only", authenticate(30, $site_2)->get_error_code() === 'wap_app_password_scope');

// The key a release before per-site keys kept for the whole network: honoured until it expires.
update_user_meta(31, 'wap_app_password_uuid_wp-rocket', 'uuid-network-wide');
$network_wide = ['uuid' => 'uuid-network-wide', 'app_id' => '', 'name' => 'WAP – WP Rocket', 'created' => time()];
set_route('/mcp/mcp-adapter-default-server');
check('a password under the older network-wide key still works on the MCP route', !authenticate(31, $network_wide)->has_errors());
$network_wide['created'] = time() - 3601;
check('until its hour is up', authenticate(31, $network_wide)->get_error_code() === 'wap_app_password_expired');

$GLOBALS['wap_test_multisite'] = false;
$GLOBALS['wap_test_blog_id']   = 1;

// -----------------------------------------------------------------------------
// 11. Home URL with a path (subfolder install), and plain permalinks
// -----------------------------------------------------------------------------

echo "subfolder install\n";

reset_state();
$GLOBALS['wap_test_home_url']     = 'https://example.test/blog';
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/blog/wp-json/mcp/mcp-adapter-default-server';
$item = seed(40, 'uuid-fresh', time());

set_route('/mcp/mcp-adapter-default-server');
check('a subfolder install accepts its own MCP route', !authenticate(40, $item)->has_errors());
set_route('/wp/v2/users/me');
check('and still refuses every other route', authenticate(40, $item)->get_error_code() === 'wap_app_password_scope');

$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/blog/?rest_route=/mcp/mcp-adapter-default-server';
set_route('/mcp/mcp-adapter-default-server');
check('a ?rest_route= endpoint URL resolves to its route', !authenticate(40, $item)->has_errors());

// An endpoint filtered to the REST root must not make the REST index an MCP route.
$GLOBALS['wap_test_home_url']     = 'https://example.test';
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/';
set_route('/');
check('an endpoint at the REST root never matches the REST index', authenticate(40, $item)->get_error_code() === 'wap_app_password_scope');

$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/mcp/mcp-adapter-default-server';

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
