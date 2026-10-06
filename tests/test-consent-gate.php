<?php
/**
 * Standalone unit tests for consent-gated Application Password provisioning
 * (WPIN-9085).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-consent-gate.php
 *
 * Covers the decision table in AppPasswordManager::provision():
 *   1. no consent on record            -> refuse, zero REST calls, no meta touched
 *   2. consent granted, no password    -> normal first-time mint
 *   3. consent granted, password lives -> normal revoke-and-remint (unchanged)
 *   4. consent granted, password gone  -> refuse, reset both uuid + consent meta
 * plus the wap_client_consent_granted filter (custom consent stores) and that
 * the refusal propagates end-to-end through GrndService::get_grnd().
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

$GLOBALS['wap_test_transients']    = [];
$GLOBALS['wap_test_user_meta']     = [];
$GLOBALS['wap_test_rest_requests'] = [];
$GLOBALS['wap_test_app_passwords'] = []; // user_id => [ [uuid=>..., ...], ... ]
$GLOBALS['wap_test_consent_filter'] = null; // optional override callable

function get_transient(string $key)
{
    $row = $GLOBALS['wap_test_transients'][$key] ?? null;
    if ($row === null) {
        return false;
    }
    if ($row['expires'] !== 0 && $row['expires'] <= time()) {
        unset($GLOBALS['wap_test_transients'][$key]);
        return false;
    }
    return $row['value'];
}

function set_transient(string $key, $value, int $ttl = 0): bool
{
    $GLOBALS['wap_test_transients'][$key] = [
        'value'   => $value,
        'expires' => $ttl > 0 ? time() + $ttl : 0,
    ];
    return true;
}

function delete_transient(string $key): bool
{
    unset($GLOBALS['wap_test_transients'][$key]);
    return true;
}

function get_user_meta(int $user_id, string $key, bool $single = false)
{
    return $GLOBALS['wap_test_user_meta'][$user_id][$key] ?? '';
}

function update_user_meta(int $user_id, string $key, $value): bool
{
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = $value;
    return true;
}

function delete_user_meta(int $user_id, string $key): bool
{
    unset($GLOBALS['wap_test_user_meta'][$user_id][$key]);
    return true;
}

function sanitize_key(string $key): string
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower($key));
}

function sanitize_text_field(string $value): string
{
    return trim(strip_tags($value));
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

// $GLOBALS['wap_test_consent_filter'] stands in for a host hooking wap_client_consent_granted.
function apply_filters(string $hook, $value, ...$args)
{
    if ($hook === 'wap_client_consent_granted' && is_callable($GLOBALS['wap_test_consent_filter'])) {
        return ($GLOBALS['wap_test_consent_filter'])($value, ...$args);
    }
    return $value;
}

function is_wp_error($thing): bool
{
    return $thing instanceof WP_Error;
}

class WP_Error
{
    private string $code;
    private string $message;

    public function __construct(string $code = '', string $message = '', $data = null)
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

function wp_is_application_passwords_available(): bool
{
    return true;
}

// Reads from the same store the REST mock writes to.
function wp_get_application_passwords(int $user_id): array
{
    return $GLOBALS['wap_test_app_passwords'][$user_id] ?? [];
}

// AppPasswordGuard::current_item() prefers this class over the function above; delegate to it.
class WP_Application_Passwords
{
    public static function get_user_application_password(int $user_id, string $uuid): ?array
    {
        foreach (wp_get_application_passwords($user_id) as $item) {
            if (($item['uuid'] ?? null) === $uuid) {
                return $item;
            }
        }
        return null;
    }
}

class WP_REST_Request
{
    public string $method;
    public string $route;
    private array $body = [];

    public function __construct(string $method, string $route)
    {
        $this->method = $method;
        $this->route  = $route;
    }

    public function set_body_params(array $params): void
    {
        $this->body = $params;
    }
}

class WP_REST_Response_Stub
{
    private bool $error;
    private array $data;

    public function __construct(bool $error = false)
    {
        $this->error = $error;
        $this->data  = ['password' => 'AbCd EfGh IjKl MnOp QrSt UvWx', 'uuid' => 'uuid-' . bin2hex(random_bytes(3))];
    }

    public function is_error(): bool
    {
        return $this->error;
    }

    public function as_error(): ?WP_Error
    {
        return null;
    }

    public function get_data(): array
    {
        return $this->data;
    }
}

/**
 * Stand-in for rest_do_request() that also maintains
 * $GLOBALS['wap_test_app_passwords'], so provision()'s "does the stored uuid
 * still exist" check is exercised against real create/delete side effects
 * rather than a hardcoded answer.
 */
function rest_do_request(WP_REST_Request $request)
{
    $GLOBALS['wap_test_rest_requests'][] = ['method' => $request->method, 'route' => $request->route];

    if (preg_match('#/wp/v2/users/(\d+)/application-passwords$#', $request->route, $m) && $request->method === 'POST') {
        $user_id  = (int) $m[1];
        $response = new WP_REST_Response_Stub();
        $data     = $response->get_data();
        $GLOBALS['wap_test_app_passwords'][$user_id][] = ['uuid' => $data['uuid'], 'created' => time()];
        return $response;
    }

    if (preg_match('#/wp/v2/users/(\d+)/application-passwords/([a-z0-9\-]+)$#', $request->route, $m) && $request->method === 'DELETE') {
        $user_id = (int) $m[1];
        $uuid    = $m[2];
        $GLOBALS['wap_test_app_passwords'][$user_id] = array_values(array_filter(
            $GLOBALS['wap_test_app_passwords'][$user_id] ?? [],
            static fn(array $p): bool => $p['uuid'] !== $uuid
        ));
        return new WP_REST_Response_Stub();
    }

    return new WP_REST_Response_Stub();
}

function wap_test_rest_count(): int
{
    return count($GLOBALS['wap_test_rest_requests']);
}

function wap_test_grant_consent(int $user_id, string $product): void
{
    update_user_meta($user_id, 'wap_client_consent_' . sanitize_key($product), time());
}

require __DIR__ . '/../includes/class-consent-gate.php';
require __DIR__ . '/../includes/class-app-password-guard.php';
require __DIR__ . '/../includes/class-app-password-manager.php';
require __DIR__ . '/../includes/class-token-manager.php';
require __DIR__ . '/../includes/class-grnd-provider.php';
require __DIR__ . '/../includes/class-grnd-service.php';
require __DIR__ . '/../includes/class-token-sealer.php';
require __DIR__ . '/../includes/class-wrap-key-client.php';

use GroupOne\WapClient\AppPasswordManager;
use GroupOne\WapClient\ConsentGate;
use GroupOne\WapClient\GrndService;

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

// -----------------------------------------------------------------------------
// 1. No consent on record -> refuse, zero REST calls, no meta touched
// -----------------------------------------------------------------------------

echo "case 1: consent not granted\n";

$apm = new AppPasswordManager();

$rest_before = wap_test_rest_count();
$r = $apm->provision(201, 'wp-rocket');
check('refused with wap_client_consent_required', is_wp_error($r) && $r->get_error_code() === 'wap_client_consent_required');
check('makes zero REST calls', wap_test_rest_count() === $rest_before);
check('no uuid meta was written', get_user_meta(201, 'wap_app_password_uuid_wp-rocket', true) === '');

// -----------------------------------------------------------------------------
// 2. Consent granted, no password on record -> normal first-time mint
// -----------------------------------------------------------------------------

echo "case 2: consent granted, first mint\n";

wap_test_grant_consent(202, 'wp-rocket');
$r = $apm->provision(202, 'wp-rocket');
check('mints normally', is_string($r) && $r !== '');
check('uuid is stored', get_user_meta(202, 'wap_app_password_uuid_wp-rocket', true) !== '');
check('consent meta is untouched', ConsentGate::is_granted(202, 'wp-rocket'));

// -----------------------------------------------------------------------------
// 3. Consent granted, stored password still resolves -> normal revoke+remint
// -----------------------------------------------------------------------------

echo "case 3: consent granted, password still live (rotation)\n";

$first_uuid = get_user_meta(202, 'wap_app_password_uuid_wp-rocket', true);
check('precondition: stored password currently resolves', wp_get_application_passwords(202) !== [] && $first_uuid !== '');

$rest_before = wap_test_rest_count();
$r2 = $apm->provision(202, 'wp-rocket');
check('rotation mints a new password', is_string($r2) && $r2 !== '' && $r2 !== $first_uuid);
check('rotation revokes then creates (2 REST calls)', wap_test_rest_count() === $rest_before + 2);
$second_uuid = get_user_meta(202, 'wap_app_password_uuid_wp-rocket', true);
check('stored uuid changed', $second_uuid !== '' && $second_uuid !== $first_uuid);
check('consent meta is untouched by a normal rotation', ConsentGate::is_granted(202, 'wp-rocket'));

// -----------------------------------------------------------------------------
// 4. Consent granted, stored password vanished out-of-band -> fail closed
// -----------------------------------------------------------------------------

echo "case 4: consent on record but password missing (admin-revoked)\n";

wap_test_grant_consent(203, 'wp-rocket');
$r = $apm->provision(203, 'wp-rocket');
check('precondition: first mint succeeds', is_string($r) && $r !== '');
$uuid_203 = get_user_meta(203, 'wap_app_password_uuid_wp-rocket', true);
check('precondition: uuid on record', $uuid_203 !== '');

// Simulate an out-of-band admin revocation — the uuid meta is left stale on purpose.
$GLOBALS['wap_test_app_passwords'][203] = [];

$rest_before = wap_test_rest_count();
$r2 = $apm->provision(203, 'wp-rocket');
check('refused with wap_client_consent_required', is_wp_error($r2) && $r2->get_error_code() === 'wap_client_consent_required');
check('makes zero REST calls (no revoke attempt on a dead uuid, no mint)', wap_test_rest_count() === $rest_before);
check('stale uuid meta is cleared', get_user_meta(203, 'wap_app_password_uuid_wp-rocket', true) === '');
check('consent is reset — user must re-confirm', !ConsentGate::is_granted(203, 'wp-rocket'));

// Must not loop forever on the same dead state — falls into case 1 (no consent), not case 4 again.
$r3 = $apm->provision(203, 'wp-rocket');
check('next call is a clean "no consent" refusal, not stuck repeating case 4', is_wp_error($r3) && $r3->get_error_code() === 'wap_client_consent_required');

// -----------------------------------------------------------------------------
// 5. wap_client_consent_granted filter — a host's own consent store
// -----------------------------------------------------------------------------

echo "case 5: custom consent store via filter\n";

// No meta at all here — a host's own consent store must authorize minting via the filter alone.
$GLOBALS['wap_test_consent_filter'] = static function (bool $default, int $user_id, string $product): bool {
    return $user_id === 301 && $product === 'rank-math';
};

check('ConsentGate defers to the filter (granted)', ConsentGate::is_granted(301, 'rank-math'));
check('ConsentGate defers to the filter (refused for a different user)', !ConsentGate::is_granted(302, 'rank-math'));

$r = $apm->provision(301, 'rank-math');
check('provision() mints when the filter grants consent', is_string($r) && $r !== '');

$r = $apm->provision(302, 'rank-math');
check('provision() refuses when the filter withholds consent', is_wp_error($r) && $r->get_error_code() === 'wap_client_consent_required');

$GLOBALS['wap_test_consent_filter'] = null;

// -----------------------------------------------------------------------------
// 6. End-to-end: GrndService::get_grnd() propagates the refusal on a cache miss
// -----------------------------------------------------------------------------

echo "case 6: GrndService propagates consent refusal end-to-end\n";

$keypair    = sodium_crypto_box_keypair();
$public_b64 = base64_encode(sodium_crypto_box_publickey($keypair));

// wp_remote_* is only needed here, where GrndService (via WrapKeyClient) is exercised.
$GLOBALS['wap_test_http'] = ['queue' => [], 'log' => []];

function wap_test_http_dispatch(string $method, string $url, array $args)
{
    $GLOBALS['wap_test_http']['log'][] = ['method' => $method, 'url' => $url, 'args' => $args];
    $response = array_shift($GLOBALS['wap_test_http']['queue']);
    return $response ?? ['code' => 200, 'body' => '{}'];
}

function wp_remote_get(string $url, array $args = [])
{
    return wap_test_http_dispatch('GET', $url, $args);
}

function wp_remote_post(string $url, array $args = [])
{
    return wap_test_http_dispatch('POST', $url, $args);
}

function wp_remote_retrieve_response_code($response): int
{
    return (int) ($response['code'] ?? 0);
}

function wp_remote_retrieve_body($response): string
{
    return (string) ($response['body'] ?? '');
}

function wp_json_encode($data)
{
    return json_encode($data);
}

function wap_test_queue(int $code, array $body): void
{
    $GLOBALS['wap_test_http']['queue'][] = ['code' => $code, 'body' => (string) json_encode($body)];
}

function home_url(string $path = ''): string
{
    return 'https://customer-site.test' . $path;
}

// No consent for user 401 — a cache miss must fail closed before the wrap-key fetch.
$rest_before  = wap_test_rest_count();
$http_before  = count($GLOBALS['wap_test_http']['log']);

$result = GrndService::get_grnd([
    'product'        => 'wp-rocket',
    'server_url'     => 'https://wap.test',
    'issuer_url'     => 'https://api.brand.test/grnd/token',
    'user_id'        => 401,
    'user_login'     => 'editor',
    'password_label' => 'WP Rocket',
]);

check(
    'get_grnd() surfaces wap_client_consent_required on a cache miss without consent',
    is_wp_error($result) && $result->get_error_code() === 'wap_client_consent_required'
);
check('no App Password REST call was made', wap_test_rest_count() === $rest_before);
check('no wrap-key/issuer HTTP call was made', count($GLOBALS['wap_test_http']['log']) === $http_before);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
