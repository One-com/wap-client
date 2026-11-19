<?php
/**
 * Standalone unit tests for the per-user chat reference (UserRef).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-user-ref.php
 *
 * Covers: lazy creation, validation of what is read back, the unique-add race
 * and the always-re-read rule, the user-id guard, the reset on "Delete my data",
 * and the manual class map listing every library class.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');
require __DIR__ . '/fixtures/app-password-shims.php';
define('HOUR_IN_SECONDS', 3600);
define('MINUTE_IN_SECONDS', 60);
define('WAP_CLIENT_DEV_MODE', true);

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

// User meta as WordPress keeps it: one list of rows per key. add_user_meta() with
// $unique refuses a second row. A test plays a rival writer through
// $GLOBALS['wap_test_before_add'] (runs before the uniqueness check, so the add loses)
// or $GLOBALS['wap_test_before_store'] (after the check, so both adds succeed).
$GLOBALS['wap_test_user_meta'] = [];
$GLOBALS['wap_test_add_calls'] = 0;

function get_user_meta(int $user_id, string $key, bool $single = false)
{
    $rows = $GLOBALS['wap_test_user_meta'][$user_id][$key] ?? [];
    if ($single) {
        return $rows[0] ?? '';
    }
    return $rows;
}

function metadata_exists(string $type, int $user_id, string $key): bool
{
    $hook = $GLOBALS['wap_test_before_exists'] ?? null;
    if (is_callable($hook)) {
        $GLOBALS['wap_test_before_exists'] = null;
        $hook($user_id, $key);
    }
    return isset($GLOBALS['wap_test_user_meta'][$user_id][$key]);
}

function add_user_meta(int $user_id, string $key, $value, bool $unique = false)
{
    $GLOBALS['wap_test_add_calls']++;
    $run_hook = static function (string $name) use ($user_id, $key): void {
        $hook = $GLOBALS[$name] ?? null;
        if (is_callable($hook)) {
            $GLOBALS[$name] = null;
            $hook($user_id, $key);
        }
    };

    $run_hook('wap_test_before_add');
    if ($unique && !empty($GLOBALS['wap_test_user_meta'][$user_id][$key])) {
        return false;
    }
    $run_hook('wap_test_before_store');

    $GLOBALS['wap_test_user_meta'][$user_id][$key][] = $value;
    return count($GLOBALS['wap_test_user_meta'][$user_id][$key]);
}

function update_user_meta(int $user_id, string $key, $value): bool
{
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = [$value];
    return true;
}

function delete_user_meta(int $user_id, string $key, $value = ''): bool
{
    $hook = $GLOBALS['wap_test_before_delete'] ?? null;
    if (is_callable($hook)) {
        $GLOBALS['wap_test_before_delete'] = null;
        $hook($user_id, $key);
    }
    // Like WordPress: an empty value deletes every row, otherwise only rows equal to it.
    if ('' === $value) {
        unset($GLOBALS['wap_test_user_meta'][$user_id][$key]);
        return true;
    }
    $rows = array_values(array_filter($GLOBALS['wap_test_user_meta'][$user_id][$key] ?? [], static fn($r) => $r !== $value));
    if ([] === $rows) {
        unset($GLOBALS['wap_test_user_meta'][$user_id][$key]);
    } else {
        $GLOBALS['wap_test_user_meta'][$user_id][$key] = $rows;
    }
    return true;
}

function get_transient(string $key)
{
    return $GLOBALS['wap_test_transients'][$key] ?? false;
}

function set_transient(string $key, $value, int $ttl = 0): bool
{
    $GLOBALS['wap_test_transients'][$key] = $value;
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

function apply_filters(string $hook, $value, ...$args)
{
    return $value;
}

function wp_is_application_passwords_available(): bool
{
    return true;
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

class WP_Application_Passwords
{
    public static function get_user_application_passwords(int $user_id): array
    {
        return [];
    }

    public static function delete_application_password(int $user_id, string $uuid): bool
    {
        return true;
    }
}

$GLOBALS['wpdb'] = new WapTestAppPasswordWpdb();

require dirname(__DIR__) . '/includes/class-token-manager.php';
require dirname(__DIR__) . '/includes/class-app-password-lock.php';
require dirname(__DIR__) . '/includes/class-app-password-guard.php';
require dirname(__DIR__) . '/includes/class-app-password-manager.php';
require dirname(__DIR__) . '/includes/class-gdpr-handler.php';
require dirname(__DIR__) . '/includes/class-user-ref.php';

// wap-client-api.php registers its boot hooks at load time; the facade is all this file needs from it.
function add_action(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    return true;
}
require_once dirname(__DIR__) . '/includes/class-bootstrap.php';
require_once dirname(__DIR__) . '/includes/class-wap-client.php';
require_once dirname(__DIR__) . '/wap-client-api.php';

use GroupOne\WapClient\GdprHandler;
use GroupOne\WapClient\UserRef;

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
    $GLOBALS['wap_test_user_meta']    = [];
    $GLOBALS['wap_test_add_calls']    = 0;
    $GLOBALS['wap_test_before_add']   = null;
    $GLOBALS['wap_test_before_store'] = null;
    $GLOBALS['wap_test_before_exists'] = null;
    $GLOBALS['wap_test_cache_deletes'] = [];
}

function is_unavailable($value): bool
{
    return $value instanceof WP_Error && 'wap_user_ref_unavailable' === $value->get_error_code();
}

// -----------------------------------------------------------------------------
// U1-U3: creation, idempotence, malformed values
// -----------------------------------------------------------------------------

echo "Creation\n";

reset_state();
$first = UserRef::ensure(5, 'p');
check('U1 ensure() on empty meta returns a string', is_string($first));
check('U1 the value is 32 lowercase hex characters', is_string($first) && 1 === preg_match('/^[0-9a-f]{32}\z/', $first));
check('U1 it is stored under wap_client_user_ref_p', ($GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'] ?? null) === [$first]);
check('U1 is_valid() accepts it', is_string($first) && UserRef::is_valid($first));
check('U1 meta_key() sanitises the product', 'wap_client_user_ref_my-prod_1' === UserRef::meta_key('My-Prod_1!'));

$second = UserRef::ensure(5, 'p');
check('U2 a second ensure() returns the same value', $second === $first);
check('U2 exactly one add call', 1 === $GLOBALS['wap_test_add_calls']);
check('U2 another product gets its own reference', UserRef::ensure(5, 'q') !== $first);
check('U2 another user gets its own reference', UserRef::ensure(6, 'p') !== $first);

foreach (['abc', str_repeat('a', 32) . "\n", strtoupper(str_repeat('a', 32)), str_repeat('g', 32), str_repeat('a', 33)] as $bad) {
    reset_state();
    update_user_meta(5, 'wap_client_user_ref_p', $bad);
    check('U3 stored() reads a malformed value as absent', null === UserRef::stored(5, 'p'));
    $fresh = UserRef::ensure(5, 'p');
    check('U3 a malformed value is replaced, never returned', is_string($fresh) && $fresh !== $bad && UserRef::is_valid($fresh));
    check('U3 only the fresh value is stored', ($GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'] ?? null) === [$fresh]);
}

reset_state();
update_user_meta(5, 'wap_client_user_ref_p', '');
$from_empty = UserRef::ensure(5, 'p');
check('U3 an empty-string row is replaced by a fresh reference', is_string($from_empty) && UserRef::is_valid($from_empty));
check('U3 only the fresh value is stored after an empty-string row', ($GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'] ?? null) === [$from_empty]);

reset_state();
update_user_meta(5, 'wap_client_user_ref_p', 'malformed');
$appeared = str_repeat('d', 32);
$GLOBALS['wap_test_before_exists'] = static function (int $user_id, string $key) use ($appeared): void {
    // A rival replaced the malformed row with a valid reference after stored() read it.
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = [$appeared];
};
$kept_rival = UserRef::ensure(5, 'p');
check('U3 a valid value appearing before the cleanup read is returned', $appeared === $kept_rival);
check('U3 it is kept, not deleted, and nothing was added', [$appeared] === $GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'] && 0 === $GLOBALS['wap_test_add_calls']);

check('is_valid() rejects a trailing newline', !UserRef::is_valid(str_repeat('a', 32) . "\n"));
check('is_valid() rejects the empty string', !UserRef::is_valid(''));

// A rival's valid row added between the read and the cleanup survives it.
reset_state();
$GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'] = ['ZZ'];
$rival_late = str_repeat('c', 32);
$GLOBALS['wap_test_before_delete'] = static function (int $user_id, string $key) use ($rival_late): void {
    $GLOBALS['wap_test_user_meta'][$user_id][$key][] = $rival_late;
};
$late = UserRef::ensure(5, 'p');
check('U3 a valid row added before the cleanup delete is not deleted', $late === $rival_late && UserRef::stored(5, 'p') === $rival_late);

// -----------------------------------------------------------------------------
// U4-U5: races
// -----------------------------------------------------------------------------

echo "Races\n";

reset_state();
$rival = str_repeat('b', 32);
$GLOBALS['wap_test_before_add'] = static function (int $user_id, string $key) use ($rival): void {
    // A rival writer stored its value after ensure() read nothing and before our add.
    $GLOBALS['wap_test_user_meta'][$user_id][$key] = [$rival];
};
$result = UserRef::ensure(5, 'p');
check('U4 the add loses the race and ensure() returns the rival value', $rival === $result);
check('U4 no second row was added', [$rival] === $GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p']);
check('U4 the generated value was never stored', 1 === count($GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p']));

reset_state();
$rival_row = str_repeat('c', 32);
$GLOBALS['wap_test_before_store'] = static function (int $user_id, string $key) use ($rival_row): void {
    // A second writer passed its uniqueness check too and inserted first: our add succeeds, two rows exist.
    $GLOBALS['wap_test_user_meta'][$user_id][$key][] = $rival_row;
};
$result = UserRef::ensure(5, 'p');
check('U5 ensure() returns what get_user_meta() reads back (the first row)', $rival_row === $result);
check('U5 not the value it generated', 2 === count($GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p']) && $result !== $GLOBALS['wap_test_user_meta'][5]['wap_client_user_ref_p'][1]);
check('U5 the object cache for user_meta was dropped after the add', in_array([5, 'user_meta'], $GLOBALS['wap_test_cache_deletes'], true));
check('U5 a second ensure() converges on the same value', $rival_row === UserRef::ensure(5, 'p'));

reset_state();
$cache_before = count($GLOBALS['wap_test_cache_deletes']);
UserRef::ensure(5, 'p');
check('U5 the object cache is dropped on the plain create path too', count($GLOBALS['wap_test_cache_deletes']) > $cache_before);

// -----------------------------------------------------------------------------
// U6: user guard
// -----------------------------------------------------------------------------

echo "User guard\n";

reset_state();
check('U6 ensure(0) is unavailable', is_unavailable(UserRef::ensure(0, 'p')));
check('U6 ensure(-1) is unavailable', is_unavailable(UserRef::ensure(-1, 'p')));
check('U6 nothing is stored for them', [] === $GLOBALS['wap_test_user_meta'] && 0 === $GLOBALS['wap_test_add_calls']);

// -----------------------------------------------------------------------------
// U7: "Delete my data" resets the reference
// -----------------------------------------------------------------------------

echo "GDPR erasure\n";

reset_state();
$old   = UserRef::ensure(5, 'p');
$other = UserRef::ensure(5, 'q');
$user6 = UserRef::ensure(6, 'p');
update_user_meta(5, 'wap_client_consent_p', time());
GdprHandler::purge_local_state(5);
check('U7 the reference is gone after purge_local_state()', is_string($old) && null === UserRef::stored(5, 'p'));
check('U7 every product\'s reference of that user is gone', null === UserRef::stored(5, 'q'));
check('U7 another user\'s reference is untouched', is_string($user6) && UserRef::stored(6, 'p') === $user6);
check('U7 the consent meta is gone', !isset($GLOBALS['wap_test_user_meta'][5]['wap_client_consent_p']));
$new = UserRef::ensure(5, 'p');
check('U7 the next chat gets a new reference', is_string($new) && $new !== $old && UserRef::is_valid($new));

// -----------------------------------------------------------------------------
// U9: the public getter
// -----------------------------------------------------------------------------

echo "Facade getter\n";

reset_state();
$got = \WapClient::get_user_ref('p', 5);
check('U9 get_user_ref() creates on first call, with no consent meta', 1 === preg_match('/^[0-9a-f]{32}$/', $got) && UserRef::stored(5, 'p') === $got);
check('U9 and returns the same value on the second call', $got === \WapClient::get_user_ref('p', 5) && 1 === $GLOBALS['wap_test_add_calls']);
check('U9 user 0 gets the empty string', '' === \WapClient::get_user_ref('p', 0) && '' === \WapClient::get_user_ref('p', -3));
$GLOBALS['wap_test_current_user'] = 5;
check('U9 a null user resolves to the current user', $got === \WapClient::get_user_ref('p'));
$GLOBALS['wap_test_current_user'] = 0;
check('U9 a null user with nobody logged in gets the empty string', '' === \WapClient::get_user_ref('p'));

// Held lock: the getter is reentrant and runs under it.
$held = null;
$ref  = \GroupOne\WapClient\AppPasswordLock::run(8, static function () use (&$held) {
    $held = \WapClient::get_user_ref('p', 8);
    return $held;
});
check('U9 callable from inside the user lock (a provider callable)', is_string($ref) && UserRef::is_valid($ref) && $ref === $held);

// A lock that cannot be taken falls back to a direct ensure.
$GLOBALS['wpdb']->options['_wap_client_app_password_lock_9'] = (time() + 60) . ':other';
$GLOBALS['wpdb']->fail_lock = true;
$locked = \WapClient::get_user_ref('p', 9);
$GLOBALS['wpdb']->fail_lock = false;
unset($GLOBALS['wpdb']->options['_wap_client_app_password_lock_9']);
check('U9 with the lock unavailable the getter still returns a reference', 1 === preg_match('/^[0-9a-f]{32}$/', $locked));

// -----------------------------------------------------------------------------
// U8: the manual class map lists every library class
// -----------------------------------------------------------------------------

echo "Class map\n";

$root   = dirname(__DIR__);
$source = (string) file_get_contents($root . '/wap-client.php');
$map    = [];
if (preg_match_all('/^\s*(?:\'([^\']+)\'|\\\\?([A-Za-z0-9_\\\\]+)::class)\s*=>\s*__DIR__\s*\.\s*\'([^\']+)\'/m', $source, $rows, PREG_SET_ORDER)) {
    foreach ($rows as $row) {
        $name       = '' !== $row[1] ? str_replace('\\\\', '\\', $row[1]) : $row[2];
        // `Foo::class` entries are short names resolved by the file's `use` imports.
        if (false === strpos($name, '\\')) {
            $name = 'GroupOne\\WapClient\\' . $name;
        }
        $map[$name] = $root . $row[3];
    }
}
check('U8 the class map was parsed', count($map) >= 17);

$declared = [];
foreach ((array) glob($root . '/includes/class-*.php') as $file) {
    if (preg_match_all('/^(?:final\s+|abstract\s+)?(?:class|interface|trait)\s+(\w+)/m', (string) file_get_contents($file), $found)) {
        foreach ($found[1] as $short) {
            $declared['GroupOne\\WapClient\\' . $short] = $file;
        }
    }
}
check('U8 the includes were scanned', count($declared) >= 17);

$missing = [];
foreach ($declared as $fqcn => $file) {
    if (!isset($map[$fqcn]) || realpath($map[$fqcn]) !== realpath($file)) {
        $missing[] = $fqcn;
    }
}
check('U8 every declared class maps to its own file (' . implode(', ', $missing) . ')', [] === $missing);
check('U8 UserRef is mapped', isset($map['GroupOne\\WapClient\\UserRef']));
check('U8 every mapped file exists', [] === array_filter($map, static fn(string $f): bool => !is_file($f)));

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
