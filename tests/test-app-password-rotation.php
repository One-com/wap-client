<?php
/**
 * Standalone tests for rotating WAP Application Passwords safely: the per-user
 * lock, the app_id tag, the sweep of untracked WAP passwords, per-site keys on
 * multisite and the network-activation requirement, and GDPR revocation.
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-app-password-rotation.php
 *
 * Real concurrency is out of reach of a single PHP process; the lock's waiting
 * is exercised by playing the other request from the database shim
 * ($wpdb->on_contention). Each scenario seeds core's password store
 * ($GLOBALS['wap_test_pws']) and the user meta, then calls the library.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');
require __DIR__ . '/fixtures/app-password-shims.php';
define('HOUR_IN_SECONDS', 3600);
define('MINUTE_IN_SECONDS', 60);
define('WAP_CLIENT_DEV_MODE', true); // Skip the HTTPS requirement in AppPasswordManager.

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

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

function sanitize_text_field(string $value): string
{
    return trim(strip_tags($value));
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

// $GLOBALS['wap_test_filters'][$hook] stands in for a callback hooked on $hook.
function apply_filters(string $hook, $value, ...$args)
{
    $callback = $GLOBALS['wap_test_filters'][$hook] ?? null;
    return is_callable($callback) ? $callback($value, ...$args) : $value;
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

// Core's password store, one list per user, as WP_Application_Passwords keeps it.
class WP_Application_Passwords
{
    public const USERMETA_KEY_APPLICATION_PASSWORDS = '_application_passwords';

    public static function get_user_application_passwords(int $user_id): array
    {
        return $GLOBALS['wap_test_pws'][$user_id] ?? [];
    }

    public static function get_user_application_password(int $user_id, string $uuid): ?array
    {
        foreach (self::get_user_application_passwords($user_id) as $item) {
            if ($item['uuid'] === $uuid) {
                return $item;
            }
        }
        return null;
    }

    public static function delete_application_password(int $user_id, string $uuid): bool
    {
        $GLOBALS['wap_test_pws'][$user_id] = array_values(array_filter(
            self::get_user_application_passwords($user_id),
            static fn(array $p): bool => $p['uuid'] !== $uuid
        ));
        return true;
    }
}

class WP_REST_Request
{
    public string $method;
    public string $route;
    public array $body = [];

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
    private array $data;

    public function __construct(array $data = [])
    {
        $this->data = $data;
    }

    public function is_error(): bool
    {
        return false;
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

// The two internal REST calls the manager makes, with core's side effects on the store.
function rest_do_request(WP_REST_Request $request)
{
    $GLOBALS['wap_test_rest'][] = $request;

    if ('POST' === $request->method && preg_match('#/users/(\d+)/application-passwords$#', $request->route, $m)) {
        $uuid = 'uuid-new-' . (count($GLOBALS['wap_test_rest']));
        $GLOBALS['wap_test_pws'][(int) $m[1]][] = [
            'uuid'    => $uuid,
            'app_id'  => $request->body['app_id'] ?? '',
            'name'    => $request->body['name'] ?? '',
            'created' => time(),
        ];
        return new WP_REST_Response_Stub(['uuid' => $uuid, 'password' => 'plain-' . $uuid]);
    }

    if ('DELETE' === $request->method && preg_match('#/users/(\d+)/application-passwords/(.+)$#', $request->route, $m)) {
        WP_Application_Passwords::delete_application_password((int) $m[1], $m[2]);
    }

    return new WP_REST_Response_Stub();
}

$GLOBALS['wpdb'] = new WapTestAppPasswordWpdb('wap_test_user_meta');

require __DIR__ . '/../includes/class-consent-gate.php';
require __DIR__ . '/../includes/class-app-password-guard.php';
require __DIR__ . '/../includes/class-app-password-lock.php';
require __DIR__ . '/../includes/class-app-password-manager.php';
require __DIR__ . '/../includes/class-token-manager.php';
require __DIR__ . '/../includes/class-gdpr-handler.php';

use GroupOne\WapClient\AppPasswordLock;
use GroupOne\WapClient\AppPasswordManager;
use GroupOne\WapClient\GdprHandler;

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
    $GLOBALS['wap_test_user_meta']        = [];
    $GLOBALS['wap_test_pws']              = [];
    $GLOBALS['wap_test_transients']       = [];
    $GLOBALS['wap_test_rest']             = [];
    $GLOBALS['wap_test_multisite']        = false;
    $GLOBALS['wap_test_blog_id']          = 1;
    $GLOBALS['wap_test_network_ids']      = [1];
    $GLOBALS['wap_test_sitewide_plugins'] = [];
    // The library under test sits in "<plugins>/wap-client/…", as if it were the plugin "wap-client".
    $GLOBALS['wap_test_plugin_dir']       = dirname(__DIR__, 2);
    $GLOBALS['wpdb']                      = new WapTestAppPasswordWpdb('wap_test_user_meta');
    $GLOBALS['wap_test_site_options']     = [];
    $GLOBALS['wap_test_current_user']     = 0;
    $GLOBALS['wap_test_filters']          = [];
}

function consent(int $user_id, string $product = 'wp-rocket'): void
{
    update_user_meta($user_id, 'wap_client_consent_' . $product, time());
}

function seed_pw(int $user_id, string $uuid, array $fields = []): void
{
    $GLOBALS['wap_test_pws'][$user_id][] = array_merge(['uuid' => $uuid, 'app_id' => '', 'name' => 'My app', 'created' => time()], $fields);
}

function has_pw(int $user_id, string $uuid): bool
{
    return null !== WP_Application_Passwords::get_user_application_password($user_id, $uuid);
}

function network_activate(int ...$network_ids): void
{
    foreach ($network_ids as $network_id) {
        $GLOBALS['wap_test_sitewide_plugins'][$network_id] = ['wap-client/wap-client.php' => time()];
    }
}

function rest_methods(): array
{
    return array_map(static fn(WP_REST_Request $r): string => $r->method, $GLOBALS['wap_test_rest']);
}

// -----------------------------------------------------------------------------
// 1. Every password is tagged, and the previous one is revoked
// -----------------------------------------------------------------------------

echo "tagging and rotation\n";

reset_state();
consent(1);
$password = (new AppPasswordManager())->provision(1, 'wp-rocket', 'WP Rocket');
$created  = $GLOBALS['wap_test_rest'][0] ?? null;

check('provision returns the plaintext', 'plain-uuid-new-1' === $password);
check('the password is created with the WAP app_id', $created && AppPasswordManager::APP_ID === ($created->body['app_id'] ?? null));
check('and keeps its "WAP – " label', $created && 'WAP – WP Rocket' === ($created->body['name'] ?? null));
check('its uuid is on record under the single-site key', 'uuid-new-1' === get_user_meta(1, 'wap_app_password_uuid_wp-rocket'));

$GLOBALS['wap_test_rest'] = [];
(new AppPasswordManager())->provision(1, 'wp-rocket', 'WP Rocket');
check('rotating revokes the previous password first', ['DELETE', 'POST'] === rest_methods() && !has_pw(1, 'uuid-new-1'));
check('the lock row is gone once provisioning returns', [] === $GLOBALS['wpdb']->options);

// -----------------------------------------------------------------------------
// 2. The sweep: WAP passwords nobody has on record are deleted
// -----------------------------------------------------------------------------

echo "sweep of untracked WAP passwords\n";

reset_state();
consent(2);
update_user_meta(2, 'wap_app_password_uuid_rankmath', 'uuid-rankmath-current');
seed_pw(2, 'uuid-rankmath-current', ['app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – Rank Math']);
seed_pw(2, 'uuid-restored', ['app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – WP Rocket']);
seed_pw(2, 'uuid-old-untagged', ['name' => 'WAP – wprocket', 'created' => time() - 2 * HOUR_IN_SECONDS]);
seed_pw(2, 'uuid-new-untagged', ['name' => 'WAP – wprocket', 'created' => time() - 5]);
seed_pw(2, 'uuid-users-own', ['name' => 'My phone']);
(new AppPasswordManager())->provision(2, 'wp-rocket', 'WP Rocket');

check('an untracked tagged password is deleted, whatever its age', !has_pw(2, 'uuid-restored'));
check('an untracked "WAP – " password from an older release is deleted', !has_pw(2, 'uuid-old-untagged'));
check('one created moments ago is spared (its release may not have recorded it yet)', has_pw(2, 'uuid-new-untagged'));
check("another product's tracked password is kept", has_pw(2, 'uuid-rankmath-current'));
check("the user's own Application Passwords are untouched", has_pw(2, 'uuid-users-own'));
check('the new password is kept', has_pw(2, (string) get_user_meta(2, 'wap_app_password_uuid_wp-rocket')));

check('is_wap_password: tagged', AppPasswordManager::is_wap_password(['app_id' => AppPasswordManager::APP_ID, 'name' => 'Renamed']));
check('is_wap_password: older release label', AppPasswordManager::is_wap_password(['name' => 'WAP – Rank Math Support Agent']));
check('is_wap_password: anything else', !AppPasswordManager::is_wap_password(['app_id' => '', 'name' => 'WAPITI']));

// -----------------------------------------------------------------------------
// 3. Consent and availability are still checked before the lock or any write
// -----------------------------------------------------------------------------

echo "consent first\n";

reset_state();
$refused = (new AppPasswordManager())->provision(3, 'wp-rocket');
check('no consent: refused with wap_client_consent_required', $refused instanceof WP_Error && 'wap_client_consent_required' === $refused->get_error_code());
check('no consent: no REST call, no lock taken', [] === $GLOBALS['wap_test_rest'] && [] === $GLOBALS['wpdb']->log);

// -----------------------------------------------------------------------------
// 4. Multisite: only when the library runs on every site, one password per site
// -----------------------------------------------------------------------------

echo "multisite\n";

reset_state();
check('single site: always enforced', AppPasswordManager::is_enforced_network_wide());

$GLOBALS['wap_test_multisite'] = true;
check('multisite, host plugin not network-activated: not enforced', !AppPasswordManager::is_enforced_network_wide());
check('so Application Passwords count as unavailable (the widget shows a notice)', !AppPasswordManager::are_app_passwords_available());

consent(4);
$refused = (new AppPasswordManager())->provision(4, 'wp-rocket');
check('and nothing is minted', $refused instanceof WP_Error && 'wap_app_passwords_disabled' === $refused->get_error_code() && [] === $GLOBALS['wap_test_rest']);
check('the reason names network activation', $refused instanceof WP_Error && false !== strpos($refused->get_error_message(), 'network-activated'));

network_activate(1);
check('network-activated on the only network: enforced', AppPasswordManager::is_enforced_network_wide());

$GLOBALS['wap_test_network_ids'] = [1, 2];
check('multi-network, active on network 1 only: not enforced', !AppPasswordManager::is_enforced_network_wide());
network_activate(2);
check('active on every network: enforced', AppPasswordManager::is_enforced_network_wide());

$GLOBALS['wap_test_plugin_dir'] = '/srv/elsewhere/plugins';
check('library outside the plugins folder (theme, custom path): not enforced', !AppPasswordManager::is_enforced_network_wide());

reset_state();
$GLOBALS['wap_test_multisite'] = true;
$GLOBALS['wap_test_blog_id']   = 2;
network_activate(1);
consent(5);
// A password minted by a release that kept one key for the whole network.
update_user_meta(5, 'wap_app_password_uuid_wp-rocket', 'uuid-network-wide');
seed_pw(5, 'uuid-network-wide', ['name' => 'WAP – WP Rocket']);
// Site 3's own current password.
update_user_meta(5, 'wap_app_password_uuid_wp-rocket@3', 'uuid-site-3');
seed_pw(5, 'uuid-site-3', ['app_id' => AppPasswordManager::APP_ID, 'name' => 'WAP – WP Rocket']);

(new AppPasswordManager())->provision(5, 'wp-rocket', 'WP Rocket');
$site_2 = (string) get_user_meta(5, 'wap_app_password_uuid_wp-rocket@2');

check('site 2 records its password under its own key', '' !== $site_2 && has_pw(5, $site_2));
check('the network-wide password of the older release is revoked', !has_pw(5, 'uuid-network-wide'));
check('and its key removed', '' === get_user_meta(5, 'wap_app_password_uuid_wp-rocket'));
check("site 3's password is left alone", has_pw(5, 'uuid-site-3') && 'uuid-site-3' === get_user_meta(5, 'wap_app_password_uuid_wp-rocket@3'));

// -----------------------------------------------------------------------------
// 5. GDPR erasure revokes every WAP password, on every site
// -----------------------------------------------------------------------------

echo "GDPR erasure\n";

reset_state();
update_user_meta(6, 'wap_app_password_uuid_wp-rocket', 'uuid-single');
update_user_meta(6, 'wap_app_password_uuid_rankmath@2', 'uuid-site-2');
update_user_meta(6, 'wap_client_consent_wp-rocket', time());
seed_pw(6, 'uuid-single', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(6, 'uuid-site-2', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(6, 'uuid-orphan', ['name' => 'WAP – wprocket', 'created' => time() - 30]);
seed_pw(6, 'uuid-users-own', ['name' => 'My phone']);
set_transient('wap_grnd_6_wp-rocket', ['grnd' => 'cached', 'expires_at' => time() + 3600]);

GdprHandler::purge_local_state(6);

check('every tracked WAP password is revoked, whichever site it belongs to', !has_pw(6, 'uuid-single') && !has_pw(6, 'uuid-site-2'));
check('untracked WAP passwords go too, however recent', !has_pw(6, 'uuid-orphan'));
check("the user's own Application Passwords are untouched", has_pw(6, 'uuid-users-own'));
check('no uuid meta is left', [] === array_filter(array_keys($GLOBALS['wap_test_user_meta'][6] ?? []), static fn($k) => 0 === strpos($k, 'wap_app_password_uuid_')));
check("this site's cached GRND is dropped", false === get_transient('wap_grnd_6_wp-rocket'));
check('consent is dropped', '' === get_user_meta(6, 'wap_client_consent_wp-rocket'));

// -----------------------------------------------------------------------------
// 6. The lock
// -----------------------------------------------------------------------------

echo "lock\n";

reset_state();
$wpdb = $GLOBALS['wpdb'];
$name = '_wap_client_app_password_lock_7';

$seen_inside = null;
$result = AppPasswordLock::run(7, static function () use ($wpdb, $name, &$seen_inside) {
    $seen_inside = $wpdb->options[$name] ?? null;
    return AppPasswordLock::run(7, static fn() => 'nested');
});
check('run() returns the callback result, nested runs included (re-entrant)', 'nested' === $result);
check('the row exists while held', is_string($seen_inside) && (int) $seen_inside > time());
check('and is deleted once the outermost run() ends', !isset($wpdb->options[$name]));

try {
    AppPasswordLock::run(7, static function () {
        throw new RuntimeException('boom');
    });
} catch (RuntimeException $e) {
    // Expected.
}
check('an exception in the callback still releases the lock', !isset($wpdb->options[$name]));

// Another request holds it, then finishes while this one waits.
$wpdb->options[$name] = (time() + 60) . ':other-request';
$attempts = 0;
$wpdb->on_contention = static function (WapTestAppPasswordWpdb $db) use ($name, &$attempts): void {
    if (++$attempts === 3) {
        unset($db->options[$name]);
    }
};
$waited = AppPasswordLock::run(7, static fn() => 'after waiting');
check('a held lock is waited for, then taken', 'after waiting' === $waited && 3 === $attempts);
$wpdb->on_contention = null;

// A request that died holding the lock: its lease ran out.
$wpdb->options[$name] = (time() - 1) . ':dead-request';
check('an expired lease is taken over', 'taken over' === AppPasswordLock::run(7, static fn() => 'taken over'));
check("and the dead request's row replaced, then released", !isset($wpdb->options[$name]));

// Releasing never deletes a row this request no longer owns.
$stolen = AppPasswordLock::run(7, static function () use ($wpdb, $name) {
    $wpdb->options[$name] = (time() + 60) . ':someone-else';
    return true;
});
check("release leaves a lock that is someone else's by now", $stolen && ((string) ($wpdb->options[$name] ?? '')) !== '' && false !== strpos($wpdb->options[$name], 'someone-else'));
unset($wpdb->options[$name]);

$wpdb->fail_lock = 2; // e.g. InnoDB deadlocks between concurrent inserts of the lock row.
check('a passing database error (deadlock) is retried', 'after a deadlock' === AppPasswordLock::run(7, static fn() => 'after a deadlock'));
check('and does not leave the row behind', !isset($wpdb->options[$name]));

$wpdb->fail_lock = true;
$failed = AppPasswordLock::run(7, static fn() => 'never');
check('a database error that persists fails with wap_app_password_lock_failed', $failed instanceof WP_Error && 'wap_app_password_lock_failed' === $failed->get_error_code());

consent(7);
$refused = (new AppPasswordManager())->provision(7, 'wp-rocket');
check('so provisioning refuses rather than rotating unlocked', $refused instanceof WP_Error && 'wap_app_password_lock_failed' === $refused->get_error_code() && [] === $GLOBALS['wap_test_rest']);

update_user_meta(7, 'wap_app_password_uuid_wp-rocket', 'uuid-to-revoke');
seed_pw(7, 'uuid-to-revoke', ['app_id' => AppPasswordManager::APP_ID]);
(new AppPasswordManager())->delete_stored_password(7, 'wp-rocket');
check('but a revocation still happens without it', !has_pw(7, 'uuid-to-revoke') && '' === get_user_meta(7, 'wap_app_password_uuid_wp-rocket'));
$wpdb->fail_lock = false;

// -----------------------------------------------------------------------------
// 7. A network where the library does not run on every site: nothing minted,
//    and what earlier releases minted is revoked
// -----------------------------------------------------------------------------

echo "multisite without the library everywhere\n";

reset_state();
$GLOBALS['wap_test_multisite'] = true;
consent(8);
update_user_meta(8, 'wap_app_password_uuid_wp-rocket', 'uuid-old-release');  // the network-wide key of 2.5.x
seed_pw(8, 'uuid-old-release', ['name' => 'WAP – wprocket', 'created' => time() - 2 * HOUR_IN_SECONDS]);
seed_pw(8, 'uuid-tagged', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(8, 'uuid-users-own', ['name' => 'My phone']);
$refused = (new AppPasswordManager())->provision(8, 'wp-rocket');
check('provision() still refuses', $refused instanceof WP_Error && 'wap_app_passwords_disabled' === $refused->get_error_code());
check('and revokes the WAP passwords the user already has', !has_pw(8, 'uuid-old-release') && !has_pw(8, 'uuid-tagged'));
check('with their uuid keys', '' === get_user_meta(8, 'wap_app_password_uuid_wp-rocket'));
check("but not the user's own Application Passwords", has_pw(8, 'uuid-users-own'));

reset_state();
$GLOBALS['wap_test_multisite'] = true;
seed_pw(10, 'uuid-a', ['name' => 'WAP – Rank Math Support Agent']);
seed_pw(11, 'uuid-b', ['app_id' => AppPasswordManager::APP_ID]);
update_user_meta(12, 'wap_app_password_uuid_rankmath', 'uuid-c');
seed_pw(12, 'uuid-c', ['name' => 'WAP – Rank Math Support Agent']);
seed_pw(13, 'uuid-d', ['name' => 'My phone']);
AppPasswordManager::revoke_unenforceable();
check('admin_init sweeps every user of the network once', !has_pw(10, 'uuid-a') && !has_pw(11, 'uuid-b') && !has_pw(12, 'uuid-c'));
check('leaving non-WAP passwords alone', has_pw(13, 'uuid-d'));
check('and records that the sweep ran', false !== get_site_option('wap_client_unenforceable_swept'));

seed_pw(10, 'uuid-later', ['app_id' => AppPasswordManager::APP_ID]);  // minted since, e.g. by an older copy elsewhere
seed_pw(11, 'uuid-other', ['app_id' => AppPasswordManager::APP_ID]);
$GLOBALS['wap_test_current_user'] = 10;
AppPasswordManager::revoke_unenforceable();
check("later requests revoke the current user's", !has_pw(10, 'uuid-later'));
check('without sweeping everyone again', has_pw(11, 'uuid-other'));

reset_state();
seed_pw(14, 'uuid-single', ['app_id' => AppPasswordManager::APP_ID]);
AppPasswordManager::revoke_unenforceable();
check('single site: nothing to revoke', has_pw(14, 'uuid-single'));
$GLOBALS['wap_test_multisite'] = true;
network_activate(1);
AppPasswordManager::revoke_unenforceable();
check('network-activated: nothing to revoke', has_pw(14, 'uuid-single'));

// -----------------------------------------------------------------------------
// 8. unavailable_reason() and the network-wide override
// -----------------------------------------------------------------------------

echo "unavailable_reason\n";

reset_state();
check('single site with Application Passwords: available', '' === AppPasswordManager::unavailable_reason());
$GLOBALS['wap_test_multisite'] = true;
check('per-site activation on a network: multisite', 'multisite' === AppPasswordManager::unavailable_reason());
$GLOBALS['wap_test_filters']['wap_client_enforced_network_wide'] = static fn(bool $enforced): bool => true;
check('a host whose loader the check cannot see may declare it', AppPasswordManager::is_enforced_network_wide() && '' === AppPasswordManager::unavailable_reason());
network_activate(1);
$GLOBALS['wap_test_filters']['wap_client_enforced_network_wide'] = static fn(bool $enforced): bool => false;
check('or the opposite, for a host that loads the library on some sites only', !AppPasswordManager::is_enforced_network_wide());

// -----------------------------------------------------------------------------
// 9. Deactivation helper: one product's passwords, never another product's
// -----------------------------------------------------------------------------

echo "revoke_app_passwords for one product\n";

reset_state();
$GLOBALS['wap_test_multisite'] = true;
update_user_meta(20, 'wap_app_password_uuid_wp-rocket@1', 'uuid-wpr-1');
update_user_meta(20, 'wap_app_password_uuid_wp-rocket@2', 'uuid-wpr-2');
update_user_meta(20, 'wap_app_password_uuid_rankmath@1', 'uuid-rm-1');
seed_pw(20, 'uuid-wpr-1', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(20, 'uuid-wpr-2', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(20, 'uuid-rm-1', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(20, 'uuid-orphan', ['app_id' => AppPasswordManager::APP_ID]);
seed_pw(20, 'uuid-users-own', ['name' => 'My phone']);
update_user_meta(21, 'wap_app_password_uuid_wp-rocket', 'uuid-wpr-single');
seed_pw(21, 'uuid-wpr-single', ['name' => 'WAP – wprocket', 'created' => time() - 2 * HOUR_IN_SECONDS]);

(new AppPasswordManager())->revoke_product('wp-rocket');

check("the product's passwords go, on every site and for every user", !has_pw(20, 'uuid-wpr-1') && !has_pw(20, 'uuid-wpr-2') && !has_pw(21, 'uuid-wpr-single'));
check('with their uuid keys', '' === get_user_meta(20, 'wap_app_password_uuid_wp-rocket@2') && '' === get_user_meta(21, 'wap_app_password_uuid_wp-rocket'));
check("another product's current password stays (same APP_ID)", has_pw(20, 'uuid-rm-1') && 'uuid-rm-1' === get_user_meta(20, 'wap_app_password_uuid_rankmath@1'));
check('a WAP password nobody has on record goes too', !has_pw(20, 'uuid-orphan'));
check("and the user's own Application Passwords stay", has_pw(20, 'uuid-users-own'));

// -----------------------------------------------------------------------------
// 10. Consent withdrawn while waiting for the lock, GDPR under the lock, replicas
// -----------------------------------------------------------------------------

echo "consent and erasure under the lock\n";

reset_state();
consent(30);
$wpdb = $GLOBALS['wpdb'];
$wpdb->options['_wap_client_app_password_lock_30'] = (time() + 60) . ':erasing-tab';
$wpdb->on_contention = static function (WapTestAppPasswordWpdb $db): void {
    delete_user_meta(30, 'wap_client_consent_wp-rocket'); // the other tab's erasure, which then releases
    unset($db->options['_wap_client_app_password_lock_30']);
};
$refused = (new AppPasswordManager())->provision(30, 'wp-rocket');
check('consent withdrawn while waiting for the lock: nothing is minted', $refused instanceof WP_Error && 'wap_client_consent_required' === $refused->get_error_code() && [] === $GLOBALS['wap_test_rest']);
check('taking the lock reads from the primary database (HyperDB / LudicrousDB)', $wpdb->reads_to_masters);

reset_state();
update_user_meta(31, 'wap_client_consent_wp-rocket', time());
GdprHandler::purge_local_state(31);
$lock_inserts = array_filter($GLOBALS['wpdb']->log, static fn(string $sql): bool => 0 === strpos($sql, 'INSERT IGNORE'));
check('GDPR erasure runs under the user lock', [] !== $lock_inserts && [] === $GLOBALS['wpdb']->options);
check('consent is gone after the erasure', '' === get_user_meta(31, 'wap_client_consent_wp-rocket'));

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
