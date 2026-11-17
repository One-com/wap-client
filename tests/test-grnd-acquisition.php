<?php
/**
 * Standalone unit tests for GRND acquisition: mint, seal, exchange (WPIN-8669)
 * and the v3 wire format (WPIN-8671).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-grnd-acquisition.php
 *
 * Covers: sodium sealed-box round trip against a test keypair, wrap-key fetch/
 * cache/rotation, the brand exchange payload (request inspection proves the
 * plaintext credential never leaves the site), error taxonomy, draft-schema
 * tolerance, lazy minting (factory only runs on a GRND cache miss), and the
 * session call carrying the GRND as Bearer with no legacy credential fields.
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

$GLOBALS['wap_test_transients'] = [];
$GLOBALS['wap_test_http']       = ['queue' => [], 'log' => []];

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

function sanitize_key(string $key): string
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower($key));
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

function apply_filters(string $hook, $value)
{
    return $value;
}

function home_url(string $path = ''): string
{
    return 'https://customer-site.test' . $path;
}

function wp_json_encode($data)
{
    return json_encode($data);
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

// --- HTTP mock: queue of canned responses, log of outgoing requests ----------

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

function wap_test_queue(int $code, array $body): void
{
    $GLOBALS['wap_test_http']['queue'][] = ['code' => $code, 'body' => (string) json_encode($body)];
}

function wap_test_last_request(): array
{
    $log = $GLOBALS['wap_test_http']['log'];
    return $log ? end($log) : [];
}

function wap_test_request_count(): int
{
    return count($GLOBALS['wap_test_http']['log']);
}

// --- User meta + App Password mocks (for the GrndService facade) -------------

$GLOBALS['wap_test_user_meta']    = [];
$GLOBALS['wap_test_rest_requests'] = [];

function get_user_meta(int $user_id, string $key, bool $single = false)
{
    return $GLOBALS['wap_test_user_meta'][$user_id][$key] ?? '';
}

function metadata_exists(string $type, int $user_id, string $key): bool
{
    return isset($GLOBALS['wap_test_user_meta'][$user_id][$key]);
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

// $GLOBALS['wap_test_add_fails'] makes the store silently not happen, so UserRef cannot read a value back.
$GLOBALS['wap_test_add_calls'] = 0;

function add_user_meta(int $user_id, string $key, $value, bool $unique = false)
{
    $GLOBALS['wap_test_add_calls']++;
    if (!empty($GLOBALS['wap_test_add_fails']) || ($unique && isset($GLOBALS['wap_test_user_meta'][$user_id][$key]))) {
        return false;
    }
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = $value;
    return 1;
}

function sanitize_text_field(string $value): string
{
    return trim(strip_tags($value));
}

function wp_is_application_passwords_available(): bool
{
    return true;
}

// Revoked-out-of-band case is covered in test-consent-gate.php; always empty here.
function wp_get_application_passwords(int $user_id): array
{
    return [];
}

// AppPasswordGuard::current_item() prefers this class; empty unless a test
// seeds a uuid via wap_test_seed_password() (see test-app-password-guard.php).
$GLOBALS['wap_test_application_pws'] = [];

class WP_Application_Passwords
{
    public static function get_user_application_passwords(int $user_id): array
    {
        return $GLOBALS['wap_test_application_pws'][$user_id] ?? [];
    }

    public static function delete_application_password(int $user_id, string $uuid): bool
    {
        $GLOBALS['wap_test_deleted_pws'][] = $uuid;
        $GLOBALS['wap_test_application_pws'][$user_id] = array_values(array_filter(
            $GLOBALS['wap_test_application_pws'][$user_id] ?? [],
            static fn(array $p): bool => $p['uuid'] !== $uuid
        ));
        return true;
    }

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

function wap_test_grant_consent(int $user_id, string $product): void
{
    update_user_meta($user_id, 'wap_client_consent_' . sanitize_key($product), time());
}

/**
 * Stand-in for WP_REST_Request/rest_do_request: records every internal REST
 * call so a test can assert that a throttled re-auth never revoked or minted
 * an Application Password.
 */
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
    private int $status;
    private ?WP_Error $error_obj;
    private array $data;

    public function __construct(bool $error = false, int $status = 200, ?WP_Error $error_obj = null)
    {
        $this->error     = $error;
        $this->status    = $status;
        $this->error_obj = $error_obj;
        $this->data      = ['password' => 'AbCd EfGh IjKl MnOp QrSt UvWx', 'uuid' => 'uuid-' . bin2hex(random_bytes(3))];
    }

    public function is_error(): bool
    {
        return $this->error;
    }

    public function as_error(): ?WP_Error
    {
        return $this->error_obj;
    }

    public function get_status(): int
    {
        return $this->status;
    }

    public function get_data(): array
    {
        return $this->data;
    }
}

$GLOBALS['wap_test_rest_response_queue'] = [];

/**
 * Queue a canned WP_REST_Response_Stub for the next rest_do_request() call,
 * so a test can simulate a specific WordPress REST response (e.g. the
 * application_passwords_disabled case).
 */
function wap_test_queue_rest_response(WP_REST_Response_Stub $response): void
{
    $GLOBALS['wap_test_rest_response_queue'][] = $response;
}

function rest_do_request(WP_REST_Request $request)
{
    $GLOBALS['wap_test_rest_requests'][] = ['method' => $request->method, 'route' => $request->route];
    return array_shift($GLOBALS['wap_test_rest_response_queue']) ?? new WP_REST_Response_Stub();
}

function wap_test_rest_count(): int
{
    return count($GLOBALS['wap_test_rest_requests']);
}

// In-memory $wpdb for AppPasswordLock and the uuid meta scans (tests/fixtures/app-password-shims.php).
$GLOBALS['wpdb'] = new WapTestAppPasswordWpdb('wap_test_user_meta');

require __DIR__ . '/../includes/class-app-password-lock.php';
require __DIR__ . '/../includes/class-consent-gate.php';
require __DIR__ . '/../includes/class-app-password-guard.php';
require __DIR__ . '/../includes/class-app-password-manager.php';
require __DIR__ . '/../includes/class-grnd-provider.php';
require __DIR__ . '/../includes/class-grnd-service.php';
require __DIR__ . '/../includes/class-token-manager.php';
require __DIR__ . '/../includes/class-token-sealer.php';
require __DIR__ . '/../includes/class-wrap-key-client.php';
require __DIR__ . '/../includes/class-user-ref.php';

// wap-client-api.php registers its boot hooks at load time; the facade is all this file needs from it.
function add_action(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    return true;
}
require_once __DIR__ . '/../includes/class-bootstrap.php';
require_once __DIR__ . '/../includes/class-wap-client.php';
require_once __DIR__ . '/../wap-client-api.php';

use GroupOne\WapClient\AppPasswordManager;
use GroupOne\WapClient\GrndService;
use GroupOne\WapClient\LicenseGrndProvider;
use GroupOne\WapClient\TokenManager;
use GroupOne\WapClient\TokenSealer;
use GroupOne\WapClient\UserRef;
use GroupOne\WapClient\WrapKeyClient;

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

function b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function make_grnd(int $exp_offset = 3600): string
{
    $header  = ['alg' => 'EdDSA', 'typ' => 'JWT'];
    $payload = [
        'sub' => 'grn:2@g1:rankmath:rankmath-com:user/1234',
        'jti' => 'grn:2@int:grnd::wap/nonce-' . bin2hex(random_bytes(4)),
        'exp' => time() + $exp_offset,
    ];
    return b64url((string) json_encode($header)) . '.'
        . b64url((string) json_encode($payload)) . '.'
        . b64url('fake-signature');
}

// -----------------------------------------------------------------------------
// 1. Sealed-box round trip (real sodium, test keypair)
// -----------------------------------------------------------------------------

echo "token sealer\n";

$keypair    = sodium_crypto_box_keypair();
$public_b64 = base64_encode(sodium_crypto_box_publickey($keypair));
$credential = 'admin:AbCd EfGh IjKl MnOp QrSt UvWx';

$sealed = TokenSealer::seal($credential, $public_b64);
check('seal returns base64 ciphertext', is_string($sealed) && base64_decode($sealed, true) !== false);
check('ciphertext does not contain the plaintext', is_string($sealed) && strpos($sealed, 'AbCd') === false);

$opened = sodium_crypto_box_seal_open((string) base64_decode((string) $sealed), $keypair);
check('WAP-side seal_open recovers username:password', $opened === $credential);

$r = TokenSealer::seal($credential, base64_encode('short'));
check('invalid wrap key rejected', is_wp_error($r) && $r->get_error_code() === 'wap_seal_failed');

echo "app password provisioning\n";

$apm = new AppPasswordManager();

// These cases exercise REST/availability error paths, not consent — grant it up front.
foreach ([101, 102, 103, 104, 105] as $consented_user) {
    wap_test_grant_consent($consented_user, 'wp-rocket');
}

// WP core returns status 501 (not 401) for both disabled cases.
wap_test_queue_rest_response(new WP_REST_Response_Stub(
    true,
    501,
    new WP_Error('application_passwords_disabled', 'Application passwords are not available.')
));
$r = $apm->provision(101, 'wp-rocket');
check(
    'application_passwords_disabled reclassified as wap_app_passwords_disabled',
    is_wp_error($r) && $r->get_error_code() === 'wap_app_passwords_disabled'
);

wap_test_queue_rest_response(new WP_REST_Response_Stub(
    true,
    501,
    new WP_Error('application_passwords_disabled_for_user', 'Not available for your account.')
));
$r = $apm->provision(104, 'wp-rocket');
check(
    'application_passwords_disabled_for_user also maps to wap_app_passwords_disabled',
    is_wp_error($r) && $r->get_error_code() === 'wap_app_passwords_disabled'
);
check(
    'per-user refusal does not claim HTTPS is the cause',
    is_wp_error($r) && strpos($r->get_error_message(), 'HTTPS') === false
);

wap_test_queue_rest_response(new WP_REST_Response_Stub(
    true,
    500,
    new WP_Error('internal_server_error', 'boom')
));
$r = $apm->provision(102, 'wp-rocket');
check(
    'other REST errors stay wap_app_password_provision_failed',
    is_wp_error($r) && $r->get_error_code() === 'wap_app_password_provision_failed'
);

// as_error() is documented WP_Error|null — an error response without one must not fatal.
wap_test_queue_rest_response(new WP_REST_Response_Stub(true, 500));
$r = $apm->provision(105, 'wp-rocket');
check(
    'error response with no WP_Error degrades gracefully',
    is_wp_error($r) && $r->get_error_code() === 'wap_app_password_provision_failed'
);

$r = $apm->provision(103, 'wp-rocket');
check('default stub (no queued response) still succeeds', is_string($r) && $r !== '');

// -----------------------------------------------------------------------------
// 2. Wrap-key client: fetch, cache, rotation, failure modes
// -----------------------------------------------------------------------------

echo "wrap key client\n";

$wkc = new WrapKeyClient('https://wap.test/');

wap_test_queue(200, ['key_id' => 'kid-1', 'public_key' => $public_b64, 'algorithm' => 'x25519-sealed-box', 'expires_at' => time() + 3600, 'future_field' => 'ignored']);
$key = $wkc->get_key();
check('wrap key fetched with key id', is_array($key) && $key['key_id'] === 'kid-1' && $key['public_key'] === $public_b64);

$requests_before = wap_test_request_count();
$key2 = $wkc->get_key();
check('second get_key served from cache', is_array($key2) && wap_test_request_count() === $requests_before);

$wkc->forget();
wap_test_queue(200, ['key_id' => 'kid-2', 'public_key' => $public_b64]);
$key3 = $wkc->get_key();
check('forget() picks up the rotated key on next fetch', is_array($key3) && $key3['key_id'] === 'kid-2');

$wkc->forget();
wap_test_queue(500, ['detail' => 'boom']);
$r = $wkc->get_key();
check('endpoint failure -> wap_wrap_key_unavailable', is_wp_error($r) && $r->get_error_code() === 'wap_wrap_key_unavailable');

wap_test_queue(200, ['key_id' => 'kid-3', 'public_key' => base64_encode('way-too-short')]);
$r = $wkc->get_key();
check('non-X25519 key rejected', is_wp_error($r) && $r->get_error_code() === 'wap_wrap_key_unavailable');
check('rejected key is not cached', get_transient('wap_wrap_key_' . md5('https://wap.test')) === false);

// -----------------------------------------------------------------------------
// 3. Brand exchange: payload, secrecy, error taxonomy, schema tolerance
// -----------------------------------------------------------------------------

echo "license exchange\n";

$factory_calls = 0;
$factory = static function () use (&$factory_calls, $credential, $public_b64) {
    $factory_calls++;
    $sealed = TokenSealer::seal($credential, $public_b64);
    return ['wrapped_app_token' => $sealed, 'wrap_key_id' => 'kid-1'];
};

$provider = new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket', $factory);

$grnd = make_grnd();
wap_test_queue(200, ['grnd' => $grnd, 'expires_at' => time() + 3600, 'draft_extra' => ['x' => 1]]);
$result = $provider->fetch();
check('exchange returns the GRND (extra fields ignored)', is_array($result) && $result['grnd'] === $grnd);

$body = json_decode((string) (wap_test_last_request()['args']['body'] ?? ''), true);
check('request carries wrapped_app_token + wrap_key_id', is_array($body) && !empty($body['wrapped_app_token']) && $body['wrap_key_id'] === 'kid-1');
check('request carries license/site/product', is_array($body) && $body['license_key'] === 'license-abc' && $body['product'] === 'wp-rocket' && $body['site_url'] === 'https://customer-site.test');
$raw_request = (string) (wap_test_last_request()['args']['body'] ?? '');
check('plaintext credential never leaves the site', strpos($raw_request, $credential) === false && strpos($raw_request, 'AbCd') === false);

wap_test_queue(403, ['detail' => 'license expired']);
$r = $provider->fetch();
check('brand 403 -> wap_grnd_not_entitled', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_not_entitled');

$failing_factory  = static fn() => new WP_Error('wap_wrap_key_unavailable', 'no key');
$failing_provider = new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket', $failing_factory);
$requests_before  = wap_test_request_count();
$r = $failing_provider->fetch();
check('factory error propagates without hitting the brand', is_wp_error($r) && $r->get_error_code() === 'wap_wrap_key_unavailable' && wap_test_request_count() === $requests_before);

$saas_provider = new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket');
wap_test_queue(200, ['grnd' => make_grnd()]);
$r = $saas_provider->fetch();
$body = json_decode((string) (wap_test_last_request()['args']['body'] ?? ''), true);
check('provider without factory omits the token fields (SaaS-style)', is_array($r) && is_array($body) && !array_key_exists('wrapped_app_token', $body) && !array_key_exists('wrap_key_id', $body));

// -----------------------------------------------------------------------------
// 4. Lazy minting: the factory only runs on a GRND cache miss
// -----------------------------------------------------------------------------

echo "lazy minting\n";

$tm = new TokenManager();
$factory_calls = 0;

// A cache hit also requires a fresh backing App Password — seed one so this
// block tests GRND caching in isolation.
update_user_meta(5, 'wap_app_password_uuid_wp-rocket', 'uuid-5-fresh');
wap_test_seed_password(5, 'uuid-5-fresh', time());

wap_test_queue(200, ['grnd' => make_grnd(), 'expires_at' => time() + 3600]);
$tm->get(5, 'wp-rocket', $provider);
check('cache miss runs the credential factory once', $factory_calls === 1);

$tm->get(5, 'wp-rocket', $provider);
check('cache hit skips minting and sealing entirely', $factory_calls === 1);

wap_test_queue(200, ['grnd' => make_grnd(), 'expires_at' => time() + 3600]);
$tm->get(5, 'wp-rocket', $provider, true);
check('force refresh mints and seals again', $factory_calls === 2);

// -----------------------------------------------------------------------------
// 5. Per-call GRND transport (no session exchange — decided 2026-07-07)
// -----------------------------------------------------------------------------
// The GRND returned by the TokenManager is handed to the browser widget as-is
// (ChatWidget::ajax_auth) and used as the Bearer credential on every WAP call.
// Guarantees: the acquisition flow makes NO call to WAP's auth endpoints, and
// the plaintext credential appears nowhere on the wire — only the sealed box
// travels, inside the issuer payload.

echo "per-call GRND transport\n";

$before_count = wap_test_request_count();
$tm_transport = new TokenManager();
wap_test_queue(200, ['grnd' => make_grnd(), 'expires_at' => time() + 3600]);
$browser_token = $tm_transport->get(7, 'wp-rocket', $provider);

check('acquired GRND is the browser token verbatim', is_string($browser_token) && substr_count($browser_token, '.') === 2);

$new_requests = array_slice($GLOBALS['wap_test_http']['log'], $before_count);
$session_calls = array_filter($new_requests, static function (array $req): bool {
    return strpos((string) ($req['url'] ?? ''), '/api/v1/auth/session') !== false;
});
check('no WAP session endpoint is ever called', count($session_calls) === 0);
check('acquisition talks only to the brand issuer', count($new_requests) === 1
    && strpos((string) ($new_requests[0]['url'] ?? ''), 'api.brand.test') !== false);

$issuer_body = json_decode((string) ($new_requests[0]['args']['body'] ?? ''), true);
check(
    'plaintext credential never on the wire — only the sealed box',
    is_array($issuer_body)
    && !array_key_exists('wp_username', $issuer_body)
    && !array_key_exists('wp_app_password', $issuer_body)
    && !empty($issuer_body['wrapped_app_token'])
    && strpos((string) ($new_requests[0]['args']['body'] ?? ''), 'AbCd') === false
);

// -----------------------------------------------------------------------------
// 6. Forced re-auth brake (WPIN-8854)
//
// A client that 401-loops asks for force_new endlessly, and every round revokes
// + re-mints an Application Password, re-fetches the wrap key and re-runs the
// issuer exchange. GrndService brakes that: REAUTH_MAX_TRIES per user/product
// per REAUTH_WINDOW, checked before any invalidation happens.
// -----------------------------------------------------------------------------

echo "forced re-auth brake\n";

$GLOBALS['wap_test_transients']    = [];
$GLOBALS['wap_test_http']          = ['queue' => [], 'log' => []];
$GLOBALS['wap_test_user_meta']     = [];
$GLOBALS['wap_test_rest_requests'] = [];

// A callable provider keeps the exchange out of the picture: this section is
// about how many times the facade is willing to re-provision at all.
$brake_grnds = 0;
$brake_args  = [
    'product'       => 'wp-rocket',
    'server_url'    => 'https://wap.test',
    'user_id'       => 7,
    'user_login'    => 'admin',
    'force_new'     => true,
    'grnd_provider' => static function () use (&$brake_grnds) {
        $brake_grnds++;
        return make_grnd();
    },
];

$allowed = 0;
for ($i = 0; $i < 5; $i++) {
    $r = GrndService::get_grnd($brake_args);
    if (!is_wp_error($r)) {
        $allowed++;
    }
}
check('5 forced re-auths within the window all mint', $allowed === 5 && $brake_grnds === 5);

$rest_before  = wap_test_rest_count();
$grnds_before = $brake_grnds;

// Stand in for a credential the user already holds. The brake is checked
// BEFORE the invalidation block, so a refusal must leave this untouched —
// declining to replace a credential is no reason to revoke the working one.
$GLOBALS['wap_test_user_meta'][7]['wap_app_password_uuid_wp-rocket'] = 'uuid-keep-me';

$sixth = GrndService::get_grnd($brake_args);

check(
    '6th forced re-auth is refused with wap_grnd_reauth_throttled',
    is_wp_error($sixth) && $sixth->get_error_code() === 'wap_grnd_reauth_throttled'
);
check('throttled call mints no GRND', $brake_grnds === $grnds_before);
check(
    'throttled call does not touch the App Password (no REST calls)',
    wap_test_rest_count() === $rest_before
);

check(
    'throttled call leaves the stored App Password uuid in place',
    ($GLOBALS['wap_test_user_meta'][7]['wap_app_password_uuid_wp-rocket'] ?? '') === 'uuid-keep-me'
);

// The window is per user AND per product, like the GRND cache itself: one
// product burning its budget must not lock the user out of another, and one
// user must not spend another's.
$other_product = GrndService::get_grnd(array_merge($brake_args, ['product' => 'rank-math']));
$other_user    = GrndService::get_grnd(array_merge($brake_args, ['user_id' => 8, 'user_login' => 'editor']));
check('a second product has its own budget', !is_wp_error($other_product));
check('a second user has their own budget', !is_wp_error($other_user));

// A non-forced call is never braked — the widget's normal path must keep
// working even while a broken client burns through the force_new budget.
$cached = GrndService::get_grnd(array_merge($brake_args, ['force_new' => false]));
check('non-forced acquisition is unaffected by the brake', !is_wp_error($cached));

// Ageing the window's start out restores the budget.
$brake_key = 'wap_grnd_rl_7_wp-rocket';
$state     = get_transient($brake_key);
set_transient($brake_key, ['count' => $state['count'], 'started' => time() - 301], 300);
$after_window = GrndService::get_grnd($brake_args);
check('budget resets once the window has passed', !is_wp_error($after_window));

// -----------------------------------------------------------------------------
// 7. One rotation per user at a time (AppPasswordLock)
//
// Two tabs past the rotation point used to mint a password each, the second
// revoking the password the first tab's GRND carries. Now the second waits for
// the first, then serves the GRND it cached.
// -----------------------------------------------------------------------------

echo "one rotation per user at a time\n";

$GLOBALS['wap_test_transients']    = [];
$GLOBALS['wap_test_user_meta']     = [];
$GLOBALS['wap_test_rest_requests'] = [];

$lock_grnds = 0;
$lock_args  = [
    'product'       => 'wp-rocket',
    'server_url'    => 'https://wap.test',
    'user_id'       => 9,
    'user_login'    => 'admin',
    'grnd_provider' => static function () use (&$lock_grnds) {
        $lock_grnds++;
        return make_grnd();
    },
];

$wpdb_shim = $GLOBALS['wpdb'];
$lock_name = '_wap_client_app_password_lock_9';
$first_tab = make_grnd();

// The first tab holds the lock, and finishes its rotation while this one waits.
$wpdb_shim->options[$lock_name] = (time() + 60) . ':first-tab';
$wpdb_shim->on_contention       = static function (WapTestAppPasswordWpdb $db) use ($lock_name, $first_tab): void {
    update_user_meta(9, 'wap_app_password_uuid_wp-rocket', 'uuid-first-tab');
    wap_test_seed_password(9, 'uuid-first-tab', time());
    set_transient('wap_grnd_9_wp-rocket', ['grnd' => $first_tab, 'expires_at' => time() + 3600], 3000);
    unset($db->options[$lock_name]);
};

$second_tab = GrndService::get_grnd($lock_args);
$wpdb_shim->on_contention = null;

check('a tab that waited for the lock serves the GRND minted meanwhile', $second_tab === $first_tab);
check('without minting a GRND or touching the App Password itself', $lock_grnds === 0 && wap_test_rest_count() === 0);
check('and releases the lock', !isset($wpdb_shim->options[$lock_name]));

$GLOBALS['wap_test_cache_deletes'] = [];
$third_tab = GrndService::get_grnd($lock_args);
check('a cache hit is served under the lock, still without minting', $third_tab === $first_tab && $lock_grnds === 0 && $wpdb_shim->options === []);
check("taking the lock drops this request's cached copy of the user meta",in_array([9, 'user_meta'], $GLOBALS['wap_test_cache_deletes'], true));

$other_user = GrndService::get_grnd(array_merge($lock_args, ['user_id' => 10]));
check('an uncontended miss mints once and releases the lock', !is_wp_error($other_user) && $lock_grnds === 1 && $wpdb_shim->options === []);

// -----------------------------------------------------------------------------
// 8. Payload extras: the provider's guard
// -----------------------------------------------------------------------------

echo "payload extras (provider)\n";

$extras_ref  = str_repeat('ab', 16);
$old_keys    = ['license_key', 'site_url', 'product', 'wrapped_app_token', 'wrap_key_id'];
$new_provider = static function (?callable $extras, ?callable $factory_override = null, int $arity = 5) use ($factory) {
    $f = $factory_override ?? $factory;
    switch ($arity) {
        case 3:
            return new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket');
        case 4:
            return new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket', $f);
        default:
            return new LicenseGrndProvider('https://api.brand.test/grnd/token', 'license-abc', 'wp-rocket', $f, [], $extras);
    }
};
$last_body = static function (): array {
    return (array) json_decode((string) (wap_test_last_request()['args']['body'] ?? ''), true);
};

foreach ([3, 4, 5] as $arity) {
    wap_test_queue(200, ['grnd' => make_grnd()]);
    $r = $new_provider(null, null, $arity)->fetch();
    $keys = array_keys($last_body());
    check("G1 {$arity}-argument construction sends no user_ref", is_array($r) && !in_array('user_ref', $keys, true));
}

wap_test_queue(200, ['grnd' => make_grnd()]);
$r    = $new_provider(static fn() => ['user_ref' => $extras_ref])->fetch();
$body = $last_body();
check('G1 with extras the body is the old keys plus user_ref', is_array($r) && array_keys($body) === array_merge($old_keys, ['user_ref']) && $body['user_ref'] === $extras_ref);
check('G1 the plaintext credential still never leaves the site', strpos((string) wap_test_last_request()['args']['body'], 'AbCd') === false);

$bad_extras = [
    'a WP_Error'         => [static fn() => new WP_Error('boom', 'no'), 'boom'],
    'a non-array'        => [static fn() => 'user_ref', 'wap_grnd_payload_invalid'],
    'an integer key'     => [static fn() => [0 => 'x'], 'wap_grnd_payload_invalid'],
    'null'               => [static fn() => null, 'wap_grnd_payload_invalid'],
];
foreach ($old_keys as $reserved) {
    $bad_extras["reserved key {$reserved}"] = [static fn() => ['user_ref' => $extras_ref, $reserved => 'overwritten'], 'wap_grnd_payload_invalid'];
}
foreach ($bad_extras as $label => [$callback, $code]) {
    $before = wap_test_request_count();
    $r      = $new_provider($callback)->fetch();
    check("G2 {$label} returns {$code} and makes no HTTP request", is_wp_error($r) && $r->get_error_code() === $code && wap_test_request_count() === $before);
}

$extras_calls = 0;
$before       = wap_test_request_count();
$r            = $new_provider(static function () use (&$extras_calls) {
    $extras_calls++;
    return ['user_ref' => 'x'];
}, $failing_factory)->fetch();
check('G3 the credential error is returned first', is_wp_error($r) && $r->get_error_code() === 'wap_wrap_key_unavailable');
check('G3 the extras callable never ran and nothing was sent', 0 === $extras_calls && wap_test_request_count() === $before);

// -----------------------------------------------------------------------------
// 9. Payload extras: composition (private helper, via reflection)
// -----------------------------------------------------------------------------

echo "payload extras (composition)\n";

$compose = new ReflectionMethod(GrndService::class, 'compose_extras');
$compose->setAccessible(true);

check('G4 no contributors gives the provider null', null === $compose->invoke(null, []));

$ran    = [];
$merged = $compose->invoke(null, [
    static function () use (&$ran, $extras_ref) {
        $ran[] = 'a';
        return ['user_ref' => $extras_ref];
    },
    static function () use (&$ran) {
        $ran[] = 'b';
        return ['permissions' => ['x' => 'allow']];
    },
]);
check('G4 two contributors are merged in order', is_callable($merged) && $merged() === ['user_ref' => $extras_ref, 'permissions' => ['x' => 'allow']] && $ran === ['a', 'b']);

$ran   = [];
$first = $compose->invoke(null, [
    static function () use (&$ran) {
        $ran[] = 'a';
        return new WP_Error('first', 'first');
    },
    static function () use (&$ran) {
        $ran[] = 'b';
        return new WP_Error('second', 'second');
    },
]);
$r = $first();
check('G4 the first WP_Error wins and later contributors do not run', is_wp_error($r) && 'first' === $r->get_error_code() && $ran === ['a']);

$ran  = [];
$dupe = $compose->invoke(null, [
    static function () use (&$ran, $extras_ref) {
        $ran[] = 'a';
        return ['user_ref' => $extras_ref];
    },
    static function () use (&$ran) {
        $ran[] = 'b';
        return ['user_ref' => str_repeat('0', 32)];
    },
]);
$r = $dupe();
check('G4 two contributors setting one field is an error, not a silent overwrite', is_wp_error($r) && 'wap_grnd_payload_invalid' === $r->get_error_code() && false !== strpos($r->get_error_message(), 'user_ref'));
check('G4 the error names the field, not its value', is_wp_error($r) && false === strpos($r->get_error_message(), str_repeat('0', 32)));

$reserved = $compose->invoke(null, [static fn() => ['site_url' => 'https://evil.test']]);
$before   = wap_test_request_count();
$r        = $new_provider($reserved)->fetch();
check('G4 a composed result with a reserved key still fails the provider guard', is_wp_error($r) && 'wap_grnd_payload_invalid' === $r->get_error_code() && wap_test_request_count() === $before);

$permissions_only = $compose->invoke(null, [static fn() => ['permissions' => ['x' => 'deny']]]);
check('G4 a single permissions-style contributor still builds the closure', is_callable($permissions_only));

// -----------------------------------------------------------------------------
// 10. send_user_ref through GrndService
// -----------------------------------------------------------------------------

echo "send_user_ref (GrndService)\n";

function g_reset(): void
{
    $GLOBALS['wap_test_transients']     = [];
    $GLOBALS['wap_test_http']           = ['queue' => [], 'log' => []];
    $GLOBALS['wap_test_user_meta']      = [];
    $GLOBALS['wap_test_rest_requests']  = [];
    $GLOBALS['wap_test_rest_response_queue'] = [];
    $GLOBALS['wap_test_application_pws'] = [];
    $GLOBALS['wap_test_add_calls']      = 0;
    $GLOBALS['wap_test_add_fails']      = false;
    $GLOBALS['wap_test_cache_deletes']  = [];
    $GLOBALS['wpdb']->options           = [];
    $GLOBALS['wpdb']->on_contention     = null;
}

function g_args(array $over = []): array
{
    return array_merge([
        'product'       => 'wp-rocket',
        'server_url'    => 'https://wap.test',
        'issuer_url'    => 'https://api.brand.test/grnd/token',
        'license_key'   => 'lic-1',
        'user_id'       => 4242,
        'user_login'    => 'alice_login',
        'send_user_ref' => true,
    ], $over);
}

/** Queue what one built-in exchange needs: the wrap key (only when not cached yet) and the issuer reply. */
function g_queue_exchange(bool $with_wrap_key = true): void
{
    global $public_b64;
    if ($with_wrap_key) {
        wap_test_queue(200, ['key_id' => 'kid-1', 'public_key' => $public_b64, 'expires_at' => time() + 3600]);
    }
    wap_test_queue(200, ['grnd' => make_grnd(), 'expires_at' => time() + 3600]);
}

/** Make the App Password the last exchange minted look fresh, so a cached GRND counts as servable. */
function g_seed_fresh_password(int $user_id): void
{
    $uuid = (string) ($GLOBALS['wap_test_user_meta'][$user_id]['wap_app_password_uuid_wp-rocket'] ?? '');
    if ('' !== $uuid) {
        wap_test_seed_password($user_id, $uuid, time());
    }
}

function g_issuer_requests(): array
{
    return array_values(array_filter($GLOBALS['wap_test_http']['log'], static function (array $req): bool {
        return false !== strpos((string) $req['url'], 'api.brand.test');
    }));
}

function g_issuer_body(int $index = -1): array
{
    $requests = g_issuer_requests();
    $request  = -1 === $index ? end($requests) : ($requests[$index] ?? []);

    return (array) json_decode((string) ($request['args']['body'] ?? ''), true);
}

$ref_key = 'wap_client_user_ref_wp-rocket';

// G5: no consent, no reference.
g_reset();
$stale = ['grnd' => make_grnd(), 'expires_at' => time() + 3600];
set_transient('wap_grnd_4242_wp-rocket', $stale, 3000);
$r = GrndService::get_grnd(g_args());
check('G5 without consent the credential step refuses', is_wp_error($r) && 'wap_client_consent_required' === $r->get_error_code());
check('G5 no reference was created', 0 === $GLOBALS['wap_test_add_calls'] && !isset($GLOBALS['wap_test_user_meta'][4242][$ref_key]));
check('G5 the cached token was not dropped', false !== get_transient('wap_grnd_4242_wp-rocket'));
check('G5 nothing was sent to the issuer', [] === g_issuer_requests());

// G6: option off is byte-identical to today.
$bodies = [];
foreach ([[], ['send_user_ref' => false]] as $variant) {
    g_reset();
    wap_test_grant_consent(4242, 'wp-rocket');
    $args = g_args($variant);
    if ([] === $variant) {
        unset($args['send_user_ref']);
    }
    g_queue_exchange();
    $r = GrndService::get_grnd($args);
    $body = g_issuer_body();
    $body['wrapped_app_token'] = 'SEALED';
    $bodies[] = json_encode($body);
    check('G6 option off: no reference stored and none created', 0 === $GLOBALS['wap_test_add_calls'] && !isset($GLOBALS['wap_test_user_meta'][4242][$ref_key]));
    check('G6 option off: the exchange succeeded', is_string($r));
}
check('G6 option absent and false send the same body', $bodies[0] === $bodies[1]);
check(
    'G6 and it is the pre-change shape',
    $bodies[0] === '{"license_key":"lic-1","site_url":"https:\/\/customer-site.test","product":"wp-rocket","wrapped_app_token":"SEALED","wrap_key_id":"kid-1"}'
);

// G7: option on, empty cache, no reference.
g_reset();
wap_test_grant_consent(4242, 'wp-rocket');
g_queue_exchange();
$r      = GrndService::get_grnd(g_args());
$body   = g_issuer_body();
$stored = $GLOBALS['wap_test_user_meta'][4242][$ref_key] ?? null;
check('G7 the exchange succeeded', is_string($r));
check('G7 the reference was created once before the exchange', is_string($stored) && UserRef::is_valid($stored) && 1 === $GLOBALS['wap_test_add_calls']);
check('G7 the body carries it', ($body['user_ref'] ?? null) === $stored && 1 === count(g_issuer_requests()));
$raw = (string) end($GLOBALS['wap_test_http']['log'])['args']['body'];
check(
    'G7 the body carries no user id, login or email',
    false === strpos($raw, 'alice') && !in_array(4242, $body, true) && !in_array('4242', $body, true)
);
g_seed_fresh_password(4242);
$requests = wap_test_request_count();
$again    = GrndService::get_grnd(g_args());
check('G7 a second call serves the cache: no HTTP request, no meta write', $again === $r && wap_test_request_count() === $requests && 1 === $GLOBALS['wap_test_add_calls']);

// G8: stale cache.
g_reset();
wap_test_grant_consent(4242, 'wp-rocket');
g_queue_exchange();
$old = GrndService::get_grnd(g_args(['send_user_ref' => false]));
g_seed_fresh_password(4242);
$cached_before = GrndService::get_grnd(g_args(['send_user_ref' => false]));
check('G8 setup: a token minted without the option is cached', is_string($old) && $cached_before === $old && 1 === count(g_issuer_requests()));
g_queue_exchange(false);
$new = GrndService::get_grnd(g_args());
$stored = $GLOBALS['wap_test_user_meta'][4242][$ref_key] ?? null;
check('G8 one new exchange carried the reference', is_string($new) && $new !== $old && 2 === count(g_issuer_requests()) && is_string($stored) && g_issuer_body()['user_ref'] === $stored);
check('G8 the new token is cached', false !== get_transient('wap_grnd_4242_wp-rocket'));
check('G8 the throttle was not touched', false === get_transient('wap_grnd_rl_4242_wp-rocket'));
check('G8 the wrap key was kept', false !== get_transient('wap_wrap_key_' . md5('https://wap.test')));
g_seed_fresh_password(4242);
$requests = wap_test_request_count();
$served   = GrndService::get_grnd(g_args());
check('G8 with the reference stored the cached token is served with no HTTP request', $served === $new && wap_test_request_count() === $requests);

// G9: reference failure with force_new revokes nothing.
g_reset();
wap_test_grant_consent(4242, 'wp-rocket');
update_user_meta(4242, 'wap_app_password_uuid_wp-rocket', 'uuid-keep');
$GLOBALS['wap_test_add_fails'] = true;
$r = GrndService::get_grnd(g_args(['force_new' => true]));
check('G9 the exchange is aborted with wap_user_ref_unavailable', is_wp_error($r) && 'wap_user_ref_unavailable' === $r->get_error_code());
check('G9 the App Password was not revoked', 0 === wap_test_rest_count() && 'uuid-keep' === ($GLOBALS['wap_test_user_meta'][4242]['wap_app_password_uuid_wp-rocket'] ?? ''));
check('G9 the re-auth throttle was not charged', false === get_transient('wap_grnd_rl_4242_wp-rocket'));
check('G9 no wrap key was fetched and nothing was sent', 0 === wap_test_request_count());
$GLOBALS['wap_test_add_fails'] = false;

// G10: force_new keeps the same reference.
g_reset();
wap_test_grant_consent(4242, 'wp-rocket');
g_queue_exchange();
GrndService::get_grnd(g_args());
$first_ref = $GLOBALS['wap_test_user_meta'][4242][$ref_key] ?? null;
g_queue_exchange(); // force_new also drops the wrap key, so it is fetched again.
$r = GrndService::get_grnd(g_args(['force_new' => true]));
check('G10 force_new succeeded with a new exchange', is_string($r) && 2 === count(g_issuer_requests()));
check('G10 the new body carries the same reference', g_issuer_body(1)['user_ref'] === $first_ref && g_issuer_body(0)['user_ref'] === $first_ref);
check('G10 the stored value is unchanged', ($GLOBALS['wap_test_user_meta'][4242][$ref_key] ?? null) === $first_ref);

// G11: a grnd_provider host.
g_reset();
wap_test_grant_consent(4242, 'wp-rocket');
$seen = [];
$host = static function () use (&$seen) {
    $seen[] = [
        'args'  => func_get_args(),
        'adds'  => $GLOBALS['wap_test_add_calls'],
        'ref'   => \WapClient::get_user_ref('wp-rocket', 4242),
        'plain' => UserRef::stored(4242, 'wp-rocket'),
    ];
    return make_grnd();
};
// A token cached before opt-in, with a fresh password so it would be served if it were not dropped.
update_user_meta(4242, 'wap_app_password_uuid_wp-rocket', 'uuid-old');
wap_test_seed_password(4242, 'uuid-old', time());
set_transient('wap_grnd_4242_wp-rocket', ['grnd' => make_grnd(), 'expires_at' => time() + 3600], 3000);
$r = GrndService::get_grnd(g_args(['grnd_provider' => $host, 'issuer_url' => '']));
check('G11 the host callable ran once, with no arguments', is_string($r) && 1 === count($seen) && [] === $seen[0]['args']);
check('G11 the reference was created before the callable and the cached token dropped', 1 === ($seen[0]['adds'] ?? 0) && null !== $seen[0]['plain']);
check('G11 the getter inside the callable returns the same value (a read)', ($seen[0]['ref'] ?? '') === ($seen[0]['plain'] ?? null) && 1 === $GLOBALS['wap_test_add_calls']);
$r2 = GrndService::get_grnd(g_args(['grnd_provider' => $host, 'issuer_url' => '']));
check('G11 a second request serves the cache and is not re-minted', $r2 === $r && 1 === count($seen));

// G12: lock contention.
g_reset();
wap_test_grant_consent(4243, 'wp-rocket');
$lock_name = '_wap_client_app_password_lock_4243';
$other_tab = make_grnd();
$GLOBALS['wpdb']->options[$lock_name] = (time() + 60) . ':first-tab';
$GLOBALS['wpdb']->on_contention       = static function (WapTestAppPasswordWpdb $db) use ($lock_name, $other_tab): void {
    UserRef::ensure(4243, 'wp-rocket');
    update_user_meta(4243, 'wap_app_password_uuid_wp-rocket', 'uuid-first-tab');
    wap_test_seed_password(4243, 'uuid-first-tab', time());
    set_transient('wap_grnd_4243_wp-rocket', ['grnd' => $other_tab, 'expires_at' => time() + 3600], 3000);
    unset($db->options[$lock_name]);
};
$r = GrndService::get_grnd(g_args(['user_id' => 4243]));
$GLOBALS['wpdb']->on_contention = null;
check('G12 the waiting tab serves the token the first tab cached', $r === $other_tab);
check('G12 no HTTP request and no second reference', 0 === wap_test_request_count() && 1 === $GLOBALS['wap_test_add_calls']);

// -----------------------------------------------------------------------------
// 11. Permissions through GrndService (#9180): the user's choices reach the issuer
// -----------------------------------------------------------------------------

echo "permissions (GrndService)\n";

/** One built-in exchange (no user_ref unless asked); the issuer request's raw body, sealed token masked. */
function p_exchange(int $user_id, array $over = []): string
{
    g_reset();
    wap_test_grant_consent($user_id, 'wp-rocket');
    g_queue_exchange();
    $r = GrndService::get_grnd(g_args(array_merge(['user_id' => $user_id, 'send_user_ref' => false], $over)));
    if (is_wp_error($r) || [] === g_issuer_requests()) {
        echo '    (exchange failed: ' . (is_wp_error($r) ? $r->get_error_code() : 'no issuer request') . ")\n";
        return '';
    }
    $body                      = g_issuer_body();
    $body['wrapped_app_token'] = 'SEALED';

    return (string) json_encode($body);
}

$p_before = '{"license_key":"lic-1","site_url":"https:\/\/customer-site.test","product":"wp-rocket","wrapped_app_token":"SEALED","wrap_key_id":"kid-1"}';

$raw = p_exchange(4300, ['permissions' => ['manage-plugin' => 'ask', 'manage-site' => 'deny']]);
check('P1 an explicit map is sent as a JSON object', false !== strpos($raw, '"permissions":{"manage-plugin":"ask","manage-site":"deny"}'));

$raw = p_exchange(4301, ['permissions' => static fn() => ['manage-plugin' => 'allow']]);
check('P2 so is the map a permissions callable returns', false !== strpos($raw, '"permissions":{"manage-plugin":"allow"}'));

check('P3 with no rows and no argument the request is unchanged', p_exchange(4302) === $p_before);
check('P3 so with an empty map', p_exchange(4303, ['permissions' => []]) === $p_before);
check('P3 and a callable is final: one returning no map sends nothing', p_exchange(4304, ['permissions' => static fn() => null]) === $p_before);

$raw = p_exchange(4305, ['permissions' => ['manage-plugin' => 'ask', 'nested' => ['deny'], 'none' => null]]);
check('P4 only scalar values are sent, as strings', false !== strpos($raw, '"permissions":{"manage-plugin":"ask"}'));
// Only the encoding is pinned: real ids are [a-z0-9-] slugs, and an issuer may well refuse numeric ones.
p_exchange(4306, ['permissions' => ['allow', 'deny']]);
$p_requests = g_issuer_requests();
$raw        = (string) (end($p_requests)['args']['body'] ?? '');
check('P4 numeric ids still encode as a JSON object, never a list', false !== strpos($raw, '"permissions":{"0":"allow","1":"deny"}'));

$raw = p_exchange(4307, ['send_user_ref' => true, 'permissions' => ['manage-plugin' => 'deny']]);
$body = (array) json_decode($raw, true);
check('P5 with send_user_ref both fields are sent', isset($body['user_ref']) && ($body['permissions'] ?? null) === ['manage-plugin' => 'deny']);

// Read on a cache miss only, so the issuer signs the choice as it is when the GRND is minted.
$p_calls   = 0;
$p_choices = ['manage-plugin' => 'allow'];
$p_args    = g_args([
    'user_id'       => 4308,
    'send_user_ref' => false,
    'permissions'   => static function () use (&$p_calls, &$p_choices): array {
        $p_calls++;
        return $p_choices;
    },
]);
g_reset();
wap_test_grant_consent(4308, 'wp-rocket');
g_queue_exchange();
$first = GrndService::get_grnd($p_args);
g_seed_fresh_password(4308);
$again = GrndService::get_grnd($p_args);
check('P6 permissions are read once per exchange, not on a cache hit', is_string($first) && $again === $first && 1 === $p_calls);

// A changed choice drops the cached GRND (ChatWidget::ajax_permission_state → TokenManager::forget),
// so the next GRND carries it.
$p_choices = ['manage-plugin' => 'deny'];
(new TokenManager())->forget(4308, 'wp-rocket');
g_queue_exchange(false);
GrndService::get_grnd($p_args);
check('P6 after the cache drop, the next exchange carries the new choice', (g_issuer_body()['permissions'] ?? null) === ['manage-plugin' => 'deny']);

$p_host_calls = 0;
g_reset();
GrndService::get_grnd(g_args([
    'user_id'       => 4309,
    'send_user_ref' => false,
    'issuer_url'    => '',
    'grnd_provider' => static fn() => make_grnd(),
    'permissions'   => static function () use (&$p_host_calls): array {
        $p_host_calls++;
        return ['manage-plugin' => 'allow'];
    },
]));
check('P7 a host grnd_provider owns its exchange: the library reads no permissions', 0 === $p_host_calls);

// Default: the product's registered rows for the user the GRND is for. Stand in for the
// chat surfaces' registry (tested in test-chat-permissions.php) — declared only now, so
// every section above ran with no ChatWidget, as a host without a surface would.
eval('namespace GroupOne\\WapClient; class ChatWidget {
    public static array $calls = [];
    public static function permissions_for(string $product, ?int $user_id = null): array {
        self::$calls[] = [$product, $user_id];
        return ["manage-plugin" => "allow", "manage-site" => "deny"];
    }
}');

$body = (array) json_decode(p_exchange(4310), true);
check('P8 by default the registered rows are sent', ($body['permissions'] ?? null) === ['manage-plugin' => 'allow', 'manage-site' => 'deny']);
check('P8 read for this product and the user the GRND is for', \GroupOne\WapClient\ChatWidget::$calls === [['wp-rocket', 4310]]);

\GroupOne\WapClient\ChatWidget::$calls = [];
$body = (array) json_decode(p_exchange(4311, ['permissions' => ['manage-plugin' => 'deny']]), true);
check('P9 an explicit map beats the registered rows', ($body['permissions'] ?? null) === ['manage-plugin' => 'deny']);
check('P9 which are then not read at all', \GroupOne\WapClient\ChatWidget::$calls === []);
check('P9 nor for a callable returning no map', p_exchange(4312, ['permissions' => static fn() => null]) === $p_before
    && \GroupOne\WapClient\ChatWidget::$calls === []);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
