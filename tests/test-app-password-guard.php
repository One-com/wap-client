<?php
/**
 * Standalone unit tests for AppPasswordGuard (RKM-2014).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-app-password-guard.php
 *
 * Covers: is_expired/should_rotate with no password on record, with a
 * password that no longer resolves in WP core's own store (out-of-band
 * revocation), the soft/hard TTL gap, and product_for_uuid()'s reverse
 * lookup.
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

$GLOBALS['wap_test_user_meta']         = [];
$GLOBALS['wap_test_application_pws']   = []; // [user_id => [item, ...]]

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

// Mirrors WP_Application_Passwords::get_user_application_password() against an
// in-memory list the test seeds directly (see wap_test_seed_password() below).
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

// Minimal $wpdb stand-in; get_var() scans the same in-memory user-meta store the shims above use.
class WapTestWpdb
{
    public string $usermeta = 'wp_usermeta';

    public function esc_like(string $s): string
    {
        return addcslashes($s, '_%\\');
    }

    public function prepare(string $query, ...$args): array
    {
        // product_for_uuid() calls prepare() with exactly (user_id, like_pattern, uuid).
        return ['user_id' => (int) $args[0], 'like' => (string) $args[1], 'uuid' => (string) $args[2]];
    }

    public function get_var($prepared)
    {
        $user_id = $prepared['user_id'];
        $like    = $prepared['like']; // e.g. "wap\_app\_password\_uuid\_%" (esc_like'd prefix + '%').
        $uuid    = $prepared['uuid'];
        // Undo esc_like()'s backslash-escaping, then drop the trailing wildcard.
        $prefix = stripslashes(rtrim($like, '%'));

        foreach ($GLOBALS['wap_test_user_meta'][$user_id] ?? [] as $meta_key => $meta_value) {
            if (strncmp($meta_key, $prefix, strlen($prefix)) === 0 && $meta_value === $uuid) {
                return $meta_key;
            }
        }

        return null;
    }
}

$GLOBALS['wpdb'] = new WapTestWpdb();

require __DIR__ . '/../includes/class-app-password-guard.php';

use GroupOne\WapClient\AppPasswordGuard;

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
// 1. No uuid on record at all
// -----------------------------------------------------------------------------

echo "no password on record\n";

check('is_expired true with no uuid on record', AppPasswordGuard::is_expired(1, 'wp-rocket') === true);
check('should_rotate true with no uuid on record', AppPasswordGuard::should_rotate(1, 'wp-rocket') === true);
check('current_item null with no uuid on record', AppPasswordGuard::current_item(1, 'wp-rocket') === null);

// -----------------------------------------------------------------------------
// 2. uuid on record, but no longer resolves in WP core's store
// -----------------------------------------------------------------------------

echo "uuid on record but revoked out-of-band\n";

update_user_meta(2, 'wap_app_password_uuid_wp-rocket', 'uuid-gone');
// Deliberately do not seed anything into $GLOBALS['wap_test_application_pws'][2].

check('is_expired true when the uuid no longer resolves', AppPasswordGuard::is_expired(2, 'wp-rocket') === true);
check('should_rotate true when the uuid no longer resolves', AppPasswordGuard::should_rotate(2, 'wp-rocket') === true);
check('current_item null when the uuid no longer resolves', AppPasswordGuard::current_item(2, 'wp-rocket') === null);

// -----------------------------------------------------------------------------
// 3. Freshly created password — neither cutoff has been reached
// -----------------------------------------------------------------------------

echo "freshly created password\n";

update_user_meta(3, 'wap_app_password_uuid_wp-rocket', 'uuid-fresh');
wap_test_seed_password(3, 'uuid-fresh', time());

check('is_expired false for a fresh password', AppPasswordGuard::is_expired(3, 'wp-rocket') === false);
check('should_rotate false for a fresh password', AppPasswordGuard::should_rotate(3, 'wp-rocket') === false);
check(
    'current_item returns the seeded item',
    AppPasswordGuard::current_item(3, 'wp-rocket')['uuid'] === 'uuid-fresh'
);

// -----------------------------------------------------------------------------
// 4. Past the soft cutoff (50 min), still short of the hard cutoff (1h)
// -----------------------------------------------------------------------------

echo "soft/hard TTL gap\n";

update_user_meta(4, 'wap_app_password_uuid_wp-rocket', 'uuid-aging');
wap_test_seed_password(4, 'uuid-aging', time() - (51 * 60)); // 51 minutes old.

check('should_rotate true just past the 50-minute soft cutoff', AppPasswordGuard::should_rotate(4, 'wp-rocket') === true);
check('is_expired still false short of the 1-hour hard cutoff', AppPasswordGuard::is_expired(4, 'wp-rocket') === false);

// -----------------------------------------------------------------------------
// 5. Past the hard cutoff
// -----------------------------------------------------------------------------

echo "past the hard cutoff\n";

update_user_meta(5, 'wap_app_password_uuid_wp-rocket', 'uuid-old');
wap_test_seed_password(5, 'uuid-old', time() - 3601); // just over an hour old.

check('is_expired true past the 1-hour hard cutoff', AppPasswordGuard::is_expired(5, 'wp-rocket') === true);
check('should_rotate also true past the 1-hour hard cutoff', AppPasswordGuard::should_rotate(5, 'wp-rocket') === true);

// -----------------------------------------------------------------------------
// 6. product_for_uuid() reverse lookup
// -----------------------------------------------------------------------------

echo "product_for_uuid\n";

update_user_meta(6, 'wap_app_password_uuid_wp-rocket', 'uuid-rocket');
update_user_meta(6, 'wap_app_password_uuid_rankmath', 'uuid-rankmath');

check(
    'resolves the product for a known uuid',
    AppPasswordGuard::product_for_uuid(6, 'uuid-rocket') === 'wp-rocket'
);
check(
    'resolves a different product for its own uuid, same user',
    AppPasswordGuard::product_for_uuid(6, 'uuid-rankmath') === 'rankmath'
);
check(
    'returns null for a uuid this user has no meta pointing at',
    AppPasswordGuard::product_for_uuid(6, 'uuid-not-ours') === null
);
check(
    'returns null for a real uuid but the wrong user',
    AppPasswordGuard::product_for_uuid(999, 'uuid-rocket') === null
);

// -----------------------------------------------------------------------------
// 7. build_meta_key() format — the one place both AppPasswordGuard and
//    AppPasswordManager must agree on.
// -----------------------------------------------------------------------------

echo "meta key format\n";

check(
    'build_meta_key sanitizes the product slug',
    AppPasswordGuard::build_meta_key('WP Rocket!') === 'wap_app_password_uuid_wprocket'
);

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
