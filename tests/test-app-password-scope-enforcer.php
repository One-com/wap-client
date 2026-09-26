<?php
/**
 * Standalone unit tests for AppPasswordScopeEnforcer (RKM-2014).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-app-password-scope-enforcer.php
 *
 * Exercises the rest_authentication_errors callback directly (check()) rather
 * than a real WP_REST_Server dispatch — this is a pure function of ($result,
 * the authenticated uuid, the current user, the current route, the site's
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
define('HOUR_IN_SECONDS', 3600);
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['wap_test_user_meta']       = [];
$GLOBALS['wap_test_application_pws'] = [];
$GLOBALS['wap_test_current_user_id'] = 0;
$GLOBALS['wap_test_authenticated_app_password'] = null;
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
    private string $code;
    private string $message;
    private array $data;

    public function __construct(string $code = '', string $message = '', $data = null)
    {
        $this->code    = $code;
        $this->message = $message;
        $this->data    = is_array($data) ? $data : [];
    }

    public function get_error_code(): string
    {
        return $this->code;
    }

    public function get_error_message(): string
    {
        return $this->message;
    }

    public function get_error_data()
    {
        return $this->data;
    }
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

class WapTestWpdb
{
    public string $usermeta = 'wp_usermeta';

    public function esc_like(string $s): string
    {
        return addcslashes($s, '_%\\');
    }

    public function prepare(string $query, ...$args): array
    {
        return ['user_id' => (int) $args[0], 'like' => (string) $args[1], 'uuid' => (string) $args[2]];
    }

    public function get_var($prepared)
    {
        $user_id = $prepared['user_id'];
        $prefix  = stripslashes(rtrim($prepared['like'], '%'));
        $uuid    = $prepared['uuid'];

        foreach ($GLOBALS['wap_test_user_meta'][$user_id] ?? [] as $meta_key => $meta_value) {
            if (strncmp($meta_key, $prefix, strlen($prefix)) === 0 && $meta_value === $uuid) {
                return $meta_key;
            }
        }

        return null;
    }
}

$GLOBALS['wpdb'] = new WapTestWpdb();

// --- rest_authentication_errors pipeline shims -------------------------------

function add_filter(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    // check() is called directly below; this just records so register() has no side effect to fail on.
    $GLOBALS['wap_test_filters'][$hook][] = ['callback' => $callback, 'priority' => $priority];
    return true;
}

function rest_get_authenticated_app_password(): ?string
{
    return $GLOBALS['wap_test_authenticated_app_password'];
}

function get_current_user_id(): int
{
    return $GLOBALS['wap_test_current_user_id'];
}

function untrailingslashit(string $s): string
{
    return rtrim($s, '/');
}

function wp_parse_url(string $url, int $component)
{
    $parts = parse_url($url);
    if (PHP_URL_PATH === $component) {
        return $parts['path'] ?? null;
    }
    return $parts;
}

function rest_get_url_prefix(): string
{
    return 'wp-json';
}

// Namespaced stand-in for ChatWidget; kept in its own file since this script isn't itself namespaced.
require __DIR__ . '/fixtures/chat-widget-stub.php';

require __DIR__ . '/../includes/class-app-password-guard.php';
require __DIR__ . '/../includes/class-app-password-scope-enforcer.php';

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
    $GLOBALS['wap_test_user_meta']                  = [];
    $GLOBALS['wap_test_application_pws']            = [];
    $GLOBALS['wap_test_current_user_id']            = 0;
    $GLOBALS['wap_test_authenticated_app_password'] = null;
    $GLOBALS['wp']                                  = new stdClass();
    $GLOBALS['wp']->query_vars                      = [];
}

function set_route(string $route): void
{
    $GLOBALS['wp']->query_vars['rest_route'] = $route;
}

// -----------------------------------------------------------------------------
// 1. Not application-password auth at all — passthrough
// -----------------------------------------------------------------------------

echo "not application-password auth\n";

reset_state();
$result = AppPasswordScopeEnforcer::check(true);
check('passes through true unchanged when no app password authenticated', $result === true);

reset_state();
$result = AppPasswordScopeEnforcer::check(null);
check('passes through null unchanged when no app password authenticated', $result === null);

// -----------------------------------------------------------------------------
// 2. Another auth method already failed — leave it alone
// -----------------------------------------------------------------------------

echo "earlier auth failure\n";

reset_state();
$earlier_error = new WP_Error('some_other_error', 'nope');
$result = AppPasswordScopeEnforcer::check($earlier_error);
check('an already-WP_Error result is returned unchanged', $result === $earlier_error);

// -----------------------------------------------------------------------------
// 3. Application password authenticated, but not one WAP minted — passthrough
// -----------------------------------------------------------------------------

echo "non-WAP application password\n";

reset_state();
$GLOBALS['wap_test_current_user_id']            = 42;
$GLOBALS['wap_test_authenticated_app_password'] = 'uuid-not-wap';
set_route('/mcp/mcp-adapter-default-server');
$result = AppPasswordScopeEnforcer::check(true);
check('a non-WAP application password is left alone', $result === true);

// -----------------------------------------------------------------------------
// 4. WAP password, expired
// -----------------------------------------------------------------------------

echo "expired WAP password\n";

reset_state();
$GLOBALS['wap_test_current_user_id']            = 7;
$GLOBALS['wap_test_authenticated_app_password'] = 'uuid-old';
update_user_meta(7, 'wap_app_password_uuid_wp-rocket', 'uuid-old');
wap_test_seed_password(7, 'uuid-old', time() - 3601);
set_route('/mcp/mcp-adapter-default-server');

$result = AppPasswordScopeEnforcer::check(true);
check('an expired WAP password is refused', is_wp_error($result));
check('the refusal code is wap_app_password_expired', $result->get_error_code() === 'wap_app_password_expired');
check('the refusal status is 401', ($result->get_error_data()['status'] ?? null) === 401);

// -----------------------------------------------------------------------------
// 5. WAP password, fresh, wrong route
// -----------------------------------------------------------------------------

echo "fresh WAP password, wrong route\n";

reset_state();
$GLOBALS['wap_test_current_user_id']            = 8;
$GLOBALS['wap_test_authenticated_app_password'] = 'uuid-fresh';
update_user_meta(8, 'wap_app_password_uuid_wp-rocket', 'uuid-fresh');
wap_test_seed_password(8, 'uuid-fresh', time());
set_route('/wp/v2/users/me');

$result = AppPasswordScopeEnforcer::check(true);
check('a fresh WAP password on the wrong route is refused', is_wp_error($result));
check('the refusal code is wap_app_password_scope', $result->get_error_code() === 'wap_app_password_scope');
check('the refusal status is 403', ($result->get_error_data()['status'] ?? null) === 403);

// -----------------------------------------------------------------------------
// 6. WAP password, fresh, correct route — passthrough
// -----------------------------------------------------------------------------

echo "fresh WAP password, correct route\n";

reset_state();
$GLOBALS['wap_test_current_user_id']            = 9;
$GLOBALS['wap_test_authenticated_app_password'] = 'uuid-fresh';
update_user_meta(9, 'wap_app_password_uuid_wp-rocket', 'uuid-fresh');
wap_test_seed_password(9, 'uuid-fresh', time());
set_route('/mcp/mcp-adapter-default-server');

$result = AppPasswordScopeEnforcer::check(true);
check('a fresh WAP password on the MCP route passes through', $result === true);

// -----------------------------------------------------------------------------
// 7. A host that overrides wap_client_mcp_endpoint to a non-default path
// -----------------------------------------------------------------------------

echo "overridden MCP endpoint\n";

reset_state();
$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/custom/v1/mcp';
$GLOBALS['wap_test_current_user_id']            = 10;
$GLOBALS['wap_test_authenticated_app_password'] = 'uuid-fresh';
update_user_meta(10, 'wap_app_password_uuid_wp-rocket', 'uuid-fresh');
wap_test_seed_password(10, 'uuid-fresh', time());

set_route('/custom/v1/mcp');
$result = AppPasswordScopeEnforcer::check(true);
check('the overridden MCP route passes through', $result === true);

set_route('/mcp/mcp-adapter-default-server'); // the DEFAULT path, now stale for this site.
$result = AppPasswordScopeEnforcer::check(true);
check('the old default path is refused once the endpoint is overridden', is_wp_error($result));

$GLOBALS['wap_test_mcp_endpoint'] = 'https://example.test/wp-json/mcp/mcp-adapter-default-server'; // restore default.

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
