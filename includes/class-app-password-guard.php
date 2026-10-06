<?php
/**
 * App Password Guard — centralizes the age/existence clock for a WAP-managed
 * Application Password. Reads WP core's own `created` timestamp so
 * is_expired() and should_rotate() can never drift out of sync.
 *
 * @package GroupOne\WapClient
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

defined('ABSPATH') || exit;

/**
 * Age/existence checks for a (user, product) pair's WAP Application Password.
 */
final class AppPasswordGuard
{
    /** User meta key pattern: wap_app_password_uuid_{product_slug}. Canonical home — build_meta_key() below.
     * @var string */
    private const META_KEY_PREFIX = 'wap_app_password_uuid_';

    /** Hard cutoff enforced by AppPasswordScopeEnforcer: password older than this fails auth outright.
     * @var int */
    private const HARD_TTL = HOUR_IN_SECONDS; // 3600s.

    /** Soft cutoff for TokenManager's cached GRND; shorter than HARD_TTL, unrelated to TokenManager::EXPIRY_SLACK.
     * @var int */
    private const ROTATE_TTL = 50 * MINUTE_IN_SECONDS; // 3000s.

    /**
     * Whether the (user, product) pair's Application Password is past the
     * hard cutoff, or missing/unresolvable entirely.
     */
    public static function is_expired(int $wp_user_id, string $product): bool
    {
        $age = self::age($wp_user_id, $product);

        return null === $age || $age >= self::HARD_TTL;
    }

    /**
     * Whether the (user, product) pair's Application Password should be
     * rotated — past the soft cutoff, or can no longer be found at all.
     */
    public static function should_rotate(int $wp_user_id, string $product): bool
    {
        $age = self::age($wp_user_id, $product);

        return null === $age || $age >= self::ROTATE_TTL;
    }

    /**
     * The Application Password item WP core has on record for this (user,
     * product) pair's stored uuid, or null if unresolvable. Shared lookup —
     * AppPasswordManager::stored_password_still_exists() uses this too.
     */
    public static function current_item(int $wp_user_id, string $product): ?array
    {
        $uuid = get_user_meta($wp_user_id, self::build_meta_key($product), true);
        if (!$uuid || !is_string($uuid)) {
            return null;
        }

        if (class_exists('\\WP_Application_Passwords')
            && method_exists('\\WP_Application_Passwords', 'get_user_application_password')
        ) {
            $item = \WP_Application_Passwords::get_user_application_password($wp_user_id, $uuid);

            return is_array($item) ? $item : null;
        }

        // Fall back to the functional wrapper (older WP core naming).
        if (!function_exists('wp_get_application_passwords')) {
            return null;
        }

        foreach (wp_get_application_passwords($wp_user_id) as $existing) {
            if (($existing['uuid'] ?? '') === $uuid) {
                return $existing;
            }
        }

        return null;
    }

    /**
     * Which product (if any) this user's WAP-managed uuid belongs to.
     * Reverse of build_meta_key() — given a uuid, find the product that minted it.
     */
    public static function product_for_uuid(int $wp_user_id, string $uuid): ?string
    {
        global $wpdb;

        $like = $wpdb->esc_like(self::META_KEY_PREFIX) . '%';

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $meta_key = $wpdb->get_var(
            $wpdb->prepare(
                "SELECT meta_key FROM {$wpdb->usermeta} WHERE user_id = %d AND meta_key LIKE %s AND meta_value = %s LIMIT 1",
                $wp_user_id,
                $like,
                $uuid
            )
        );

        if (!$meta_key || !is_string($meta_key)) {
            return null;
        }

        $product = substr($meta_key, strlen(self::META_KEY_PREFIX));

        return '' !== $product ? $product : null;
    }

    /**
     * Build the user meta key for storing a product's App Password uuid.
     */
    public static function build_meta_key(string $product): string
    {
        return self::META_KEY_PREFIX . sanitize_key($product);
    }

    /**
     * Seconds since the (user, product) pair's Application Password was
     * created, or null when there is no password on record.
     */
    private static function age(int $wp_user_id, string $product): ?int
    {
        $item = self::current_item($wp_user_id, $product);
        if (null === $item || empty($item['created'])) {
            return null;
        }

        return time() - (int) $item['created'];
    }
}
