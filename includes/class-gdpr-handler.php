<?php
/**
 * GDPR Handler — implements the right-to-erasure flow.
 *
 * Proxies DELETE /api/v1/me/data to the WAP backend server-side (no CORS
 * preflight from the browser). The session token is passed through PHP memory
 * only — it is never stored or persisted in WordPress.
 *
 * @package Groupone\WapClient
 */

declare(strict_types=1);

namespace Groupone\WapClient;

defined('ABSPATH') || exit;

/**
 * GDPR erasure handler for the WAP client.
 *
 * Implements US12 — when a user requests deletion of their WAP data:
 *  1. Call DELETE /api/v1/me/data on the WAP backend (deletes LangGraph
 *     checkpoints, site_credentials row, and revokes the session).
 *  2. Delete all locally cached session transients for the user.
 *  3. Delete all locally stored App Passwords for the user.
 */
class GdprHandler
{
    /**
     * AJAX action name.
     *
     * @var string
     */
    public const AJAX_ACTION = 'wap_client_delete_data';

    // -------------------------------------------------------------------------
    // AJAX handler
    // -------------------------------------------------------------------------

    /**
     * AJAX handler: clean up local WordPress state after GDPR erasure.
     *
     * The WAP backend deletion is performed directly by the JS widget
     * (DELETE /api/v1/me/data with Bearer token). This handler only removes
     * local WordPress state (App Passwords) — no token is received or stored.
     *
     * @return void (sends JSON response and exits)
     */
    public static function ajax_delete_data(): void
    {
        check_ajax_referer('wap_client_delete_data');

        $capability = apply_filters('wap_client_capability', 'wap_use_ai');
        if (!current_user_can($capability)) {
            wp_send_json_error(['message' => __('Insufficient permissions.', 'wap-client')], 403);
        }

        $current_user = wp_get_current_user();
        if (!$current_user->exists()) {
            wp_send_json_error(['message' => __('User not authenticated.', 'wap-client')], 401);
        }

        self::purge_local_state($current_user->ID);

        wp_send_json_success(['message' => __('Your data has been deleted.', 'wap-client')]);
    }

    // -------------------------------------------------------------------------
    // Local state cleanup
    // -------------------------------------------------------------------------

    /**
     * Remove all WAP-related local state for a WordPress user.
     *
     * Called after a successful WAP data deletion. Revokes all stored
     * App Password user meta keys (wap_app_password_uuid_*).
     *
     * @param int $wp_user_id WordPress user ID.
     *
     * @return void
     */
    public static function purge_local_state(int $wp_user_id): void
    {
        // Revoke all active Application Passwords for this user.
        self::delete_all_app_passwords($wp_user_id);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Delete all WAP App Password user meta entries for a given user.
     *
     * Queries user meta for keys matching the wap_app_password_* prefix
     * and removes them all.
     *
     * @param int $wp_user_id WordPress user ID.
     *
     * @return void
     */
    private static function delete_all_app_passwords(int $wp_user_id): void
    {
        global $wpdb;

        $prefix       = 'wap_app_password_uuid_';
        $like_pattern = $wpdb->esc_like($prefix) . '%';

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $meta_keys = $wpdb->get_col(
            $wpdb->prepare(
                "SELECT meta_key FROM {$wpdb->usermeta} WHERE user_id = %d AND meta_key LIKE %s",
                $wp_user_id,
                $like_pattern
            )
        );

        $manager = new AppPasswordManager();
        foreach ($meta_keys as $meta_key) {
            // Extract the product slug from "wap_app_password_uuid_{product}".
            $product = substr((string) $meta_key, strlen($prefix));
            if ($product) {
                // Revokes the WP Application Password and deletes the uuid meta.
                $manager->delete_stored_password($wp_user_id, $product);
            }
        }
    }
}
