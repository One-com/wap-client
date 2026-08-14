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

function sanitize_text_field(string $value): string
{
    return trim(strip_tags($value));
}

function wp_is_application_passwords_available(): bool
{
    return true;
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
    public function is_error(): bool
    {
        return false;
    }

    public function get_data(): array
    {
        return ['password' => 'AbCd EfGh IjKl MnOp QrSt UvWx', 'uuid' => 'uuid-' . bin2hex(random_bytes(3))];
    }
}

function rest_do_request(WP_REST_Request $request)
{
    $GLOBALS['wap_test_rest_requests'][] = ['method' => $request->method, 'route' => $request->route];
    return new WP_REST_Response_Stub();
}

function wap_test_rest_count(): int
{
    return count($GLOBALS['wap_test_rest_requests']);
}

require __DIR__ . '/../includes/class-app-password-manager.php';
require __DIR__ . '/../includes/class-grnd-provider.php';
require __DIR__ . '/../includes/class-grnd-service.php';
require __DIR__ . '/../includes/class-token-manager.php';
require __DIR__ . '/../includes/class-token-sealer.php';
require __DIR__ . '/../includes/class-wrap-key-client.php';

use GroupOne\WapClient\GrndService;
use GroupOne\WapClient\LicenseGrndProvider;
use GroupOne\WapClient\TokenManager;
use GroupOne\WapClient\TokenSealer;
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

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
