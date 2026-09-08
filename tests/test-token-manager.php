<?php
/**
 * Standalone unit tests for TokenManager GRND lifecycle hardening (WPIN-8670).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-token-manager.php
 *
 * Exits 0 when all assertions pass, 1 otherwise. Covers the ticket's matrix:
 * valid token, wrong alg, wrong jti tag, missing exp, malformed structure,
 * expiring-soon refresh, force refresh, no-cache-on-invalid, issuer expiry
 * bounding, and App Password rotation ↔ GRND cache coupling.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

// -----------------------------------------------------------------------------
// Minimal WordPress shims — just enough to load and exercise the classes.
// -----------------------------------------------------------------------------

define('ABSPATH', '/');
define('WAP_CLIENT_DEV_MODE', true); // Skip the HTTPS requirement in AppPasswordManager.

$GLOBALS['wap_test_transients'] = [];
$GLOBALS['wap_test_user_meta']  = [];

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

function sanitize_text_field($str)
{
    return trim((string) $str);
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

class WP_REST_Request
{
    public string $method;
    public string $route;

    public function __construct(string $method, string $route)
    {
        $this->method = $method;
        $this->route  = $route;
    }

    public function set_body_params(array $params): void
    {
    }
}

class WapTestRestResponse
{
    private array $data;

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function is_error(): bool
    {
        return false;
    }

    public function get_data(): array
    {
        return $this->data;
    }
}

function rest_do_request(WP_REST_Request $request)
{
    if ($request->method === 'POST') {
        return new WapTestRestResponse([
            'password' => 'fresh-app-password',
            'uuid'     => 'uuid-' . substr(md5($request->route), 0, 8),
        ]);
    }
    return new WapTestRestResponse([]); // DELETE — revocation always "succeeds".
}

require __DIR__ . '/../includes/class-grnd-provider.php';
require __DIR__ . '/../includes/class-token-manager.php';
require __DIR__ . '/../includes/class-app-password-manager.php';

use GroupOne\WapClient\GrndProviderInterface;
use GroupOne\WapClient\TokenManager;
use GroupOne\WapClient\AppPasswordManager;

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

/**
 * Build an unsigned-but-well-formed JWT. Pass null to drop a claim.
 */
function make_grnd(array $header_over = [], array $payload_over = []): string
{
    $header  = array_merge(['alg' => 'EdDSA', 'typ' => 'JWT'], $header_over);
    $payload = array_merge([
        'sub' => 'grn:2@g1:rankmath:rankmath-com:user/1234',
        'iss' => 'grn:2@g1:rankmath:rankmath-com:',
        'jti' => 'grn:2@int:grnd::wap/nonce-' . bin2hex(random_bytes(4)),
        'exp' => time() + 3600,
    ], $payload_over);

    $header  = array_filter($header, static fn($v) => $v !== null);
    $payload = array_filter($payload, static fn($v) => $v !== null);

    return b64url((string) json_encode($header)) . '.'
        . b64url((string) json_encode($payload)) . '.'
        . b64url('fake-signature');
}

/**
 * Provider stub returning queued results and counting fetches.
 */
class StubProvider implements GrndProviderInterface
{
    public int $fetches = 0;

    /** @var array<int, mixed> */
    private array $queue;

    public function __construct(array $queue)
    {
        $this->queue = $queue;
    }

    public function fetch()
    {
        $this->fetches++;
        $next = count($this->queue) > 1 ? array_shift($this->queue) : $this->queue[0];
        return $next;
    }
}

function wrap(string $grnd, int $expires_at = 0): array
{
    return ['grnd' => $grnd, 'expires_at' => $expires_at];
}

// -----------------------------------------------------------------------------
// 1. sanity_check matrix
// -----------------------------------------------------------------------------

echo "sanity_check\n";

check('valid GRND passes', TokenManager::sanity_check(make_grnd()) === true);

// `typ` is OPTIONAL per RFC 7519 §5.1 and the GRN spec; spec-conformant issuers
// (e.g. wpapi's GRND minter) omit it. Absence must NOT be a rejection reason.
check(
    'valid GRND without typ header passes (spec-conformant issuer)',
    TokenManager::sanity_check(make_grnd(['typ' => null])) === true
);

// When `typ` IS present, it must be "JWT" — otherwise a brand could sneak a
// non-JWT 3-part token past this check.
$r = TokenManager::sanity_check(make_grnd(['typ' => 'foo']));
check('non-JWT typ value rejected as malformed', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_malformed');

$r = TokenManager::sanity_check('not-a-jwt');
check('non-JWT rejected as malformed', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_malformed');

$r = TokenManager::sanity_check('!!!.' . b64url('{}') . '.sig');
check('undecodable header rejected as malformed', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_malformed');

$r = TokenManager::sanity_check(make_grnd(['alg' => 'RS256']));
check('wrong alg (RS256) rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_bad_alg');

$r = TokenManager::sanity_check(make_grnd([], ['jti' => 'grn:2@int:grnd::other/nonce-1']));
check('wrong jti tag rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_bad_jti');

$r = TokenManager::sanity_check(make_grnd([], ['jti' => 'grn:1@int:grnd::wap/nonce-1']));
check('wrong GRN version rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_bad_jti');

$r = TokenManager::sanity_check(make_grnd([], ['jti' => null]));
check('missing jti rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_bad_jti');

$r = TokenManager::sanity_check(make_grnd([], ['exp' => null]));
check('missing exp rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_missing_exp');

$r = TokenManager::sanity_check(make_grnd([], ['exp' => 'soon']));
check('non-numeric exp rejected', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_missing_exp');

check(
    'jti with system.environment segment passes',
    TokenManager::sanity_check(make_grnd([], ['jti' => 'grn:2@int:grnd:grnd.prod:wap/nonce-2'])) === true
);

// -----------------------------------------------------------------------------
// 2. Cache lifecycle
// -----------------------------------------------------------------------------

echo "cache lifecycle\n";

$tm = new TokenManager();

// Fresh fetch is cached; the second get() serves from cache.
$valid    = make_grnd();
$provider = new StubProvider([wrap($valid)]);
check('first get() returns the token', $tm->get(7, 'wp-rocket', $provider) === $valid);
check('second get() served from cache', $tm->get(7, 'wp-rocket', $provider) === $valid && $provider->fetches === 1);

// Force refresh bypasses a warm cache.
$tm->get(7, 'wp-rocket', $provider, true);
check('force refresh re-fetches despite warm cache', $provider->fetches === 2);

// Expiring-soon token (inside the 60s slack) is not served from cache.
$tm->forget(8, 'wp-rocket');
$soon          = make_grnd([], ['exp' => time() + 30]);
$soon_provider = new StubProvider([wrap($soon)]);
$tm->get(8, 'wp-rocket', $soon_provider);
$tm->get(8, 'wp-rocket', $soon_provider);
check('token expiring within slack triggers re-fetch', $soon_provider->fetches === 2);

// Invalid token from the provider: error surfaces, nothing cached.
$tm->forget(9, 'wp-rocket');
$bad_provider = new StubProvider([wrap(make_grnd(['alg' => 'HS256']))]);
$r = $tm->get(9, 'wp-rocket', $bad_provider);
check('invalid provider token surfaces WP_Error', is_wp_error($r) && $r->get_error_code() === 'wap_grnd_bad_alg');
check('invalid token is not cached', get_transient('wap_grnd_9_wp-rocket') === false);

// Issuer expires_at bounds the JWT exp downward, never upward.
$tm->forget(10, 'wp-rocket');
$long = make_grnd([], ['exp' => time() + 7200]);
$tm->get(10, 'wp-rocket', new StubProvider([wrap($long, time() + 600)]));
$row = get_transient('wap_grnd_10_wp-rocket');
check('issuer expires_at shortens cache expiry', is_array($row) && $row['expires_at'] <= time() + 600);

$tm->forget(10, 'wp-rocket');
$tm->get(10, 'wp-rocket', new StubProvider([wrap($long, time() + 999999)]));
$row = get_transient('wap_grnd_10_wp-rocket');
check('issuer expires_at cannot extend past jwt exp', is_array($row) && $row['expires_at'] <= time() + 7200);

// -----------------------------------------------------------------------------
// 3. App Password rotation ↔ GRND cache coupling
// -----------------------------------------------------------------------------

echo "rotation coupling\n";

$tm->forget(11, 'wp-rocket');
$rot_provider = new StubProvider([wrap(make_grnd())]);
$tm->get(11, 'wp-rocket', $rot_provider);
check('precondition: GRND cached before rotation', get_transient('wap_grnd_11_wp-rocket') !== false);

$apm      = new AppPasswordManager();
$password = $apm->provision(11, 'wp-rocket', 'WP Rocket');
check('provision returns a password', $password === 'fresh-app-password');
check('provision invalidates the cached GRND', get_transient('wap_grnd_11_wp-rocket') === false);

$tm->get(11, 'wp-rocket', $rot_provider);
check('precondition: GRND re-cached before revocation', get_transient('wap_grnd_11_wp-rocket') !== false);
$apm->delete_stored_password(11, 'wp-rocket');
check('delete_stored_password invalidates the cached GRND', get_transient('wap_grnd_11_wp-rocket') === false);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
