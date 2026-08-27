<?php
/**
 * App Password Manager — WordPress Application Password provisioning.
 *
 * Provisions a fresh WordPress Application Password on each WAP auth call.
 * The plaintext password is passed directly to the WAP backend and never
 * stored. The uuid of the most recently created password is kept in user_meta
 * so it can be revoked before the next provisioning.
 *
 * @package GroupOne\WapClient
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

defined('ABSPATH') || exit;

/**
 * Manages WordPress Application Password provisioning for WAP auth.
 *
 * One password per (user, product) pair is kept active at a time. Each call
 * to provision() revokes the previous password (if any) before creating a new
 * one so Application Passwords do not accumulate in the user's profile.
 */
class AppPasswordManager
{
    /**
     * User meta key pattern for the uuid of the active App Password.
     * Format: wap_app_password_uuid_{product_slug}
     *
     * @var string
     */
    private const META_KEY_PREFIX = 'wap_app_password_uuid_';

    /**
     * WP Application Password label prefix, visible to site admins.
     *
     * @var string
     */
    private const APP_PASSWORD_LABEL_PREFIX = 'WAP – ';

    // -------------------------------------------------------------------------
    // Static helpers
    // -------------------------------------------------------------------------

    /**
     * Check whether WordPress Application Passwords are available.
     *
     * @return bool True when App Passwords can be used.
     */
    public static function are_app_passwords_available(): bool
    {
        // Dev bypass — define WAP_CLIENT_DEV_MODE in wp-config.php to skip the
        // HTTPS requirement on local non-SSL sites. Never use in production.
        if (defined('WAP_CLIENT_DEV_MODE') && WAP_CLIENT_DEV_MODE) {
            return true;
        }

        if (function_exists('wp_is_application_passwords_available')) {
            return wp_is_application_passwords_available();
        }

        return is_ssl();
    }

    /**
     * Whether HTTPS is the (or a) reason Application Passwords are unavailable.
     *
     * `wp_is_application_passwords_available()` is filterable, so a plugin
     * (e.g. a security plugin) can disable Application Passwords outright,
     * independent of the site's SSL status. Callers use this to distinguish
     * that case from a genuine "this site is not on HTTPS" case, so the
     * message shown to the user names the actual cause.
     *
     * @return bool True when the site is not on HTTPS (and the dev bypass is
     *              not active) — regardless of whether some other factor also
     *              disables Application Passwords.
     */
    public static function is_https_missing(): bool
    {
        if (defined('WAP_CLIENT_DEV_MODE') && WAP_CLIENT_DEV_MODE) {
            return false;
        }

        return !is_ssl();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Provision a new Application Password for the given user and product.
     *
     * Revokes the previously active password (if any) before creating a new one.
     * The plaintext password is returned for a single use in the WAP auth call
     * and must not be stored by the caller.
     *
     * @param int    $wp_user_id    WordPress user ID.
     * @param string $product       Product slug (e.g. 'wp-rocket').
     * @param string $product_label Human-readable product name for the password label.
     *
     * @return string|\WP_Error Plaintext App Password on success, WP_Error on failure.
     */
    public function provision(int $wp_user_id, string $product, string $product_label = '')
    {
        if (!self::are_app_passwords_available()) {
            return new \WP_Error(
                'wap_app_passwords_disabled',
                __('WordPress Application Passwords are not available on this site. HTTPS is required.', 'wap-client')
            );
        }

        // Revoke the previous password for this (user, product) pair.
        $this->revoke_previous($wp_user_id, $product);

        $label   = self::APP_PASSWORD_LABEL_PREFIX . ($product_label ?: $product);
        $request = new \WP_REST_Request('POST', "/wp/v2/users/{$wp_user_id}/application-passwords");
        $request->set_body_params(['name' => $label]);
        $response = rest_do_request($request);

        if ($response->is_error()) {
            return new \WP_Error(
                'wap_app_password_provision_failed',
                sprintf(
                    /* translators: 1: error message */
                    __('Failed to provision WAP Application Password: %s', 'wap-client'),
                    $response->as_error()->get_error_message()
                )
            );
        }

        $data = $response->get_data();

        if (empty($data['password']) || empty($data['uuid'])) {
            return new \WP_Error(
                'wap_app_password_missing',
                __('WordPress Application Password response did not contain expected fields.', 'wap-client')
            );
        }

        // Store the uuid so we can revoke this password before the next provisioning.
        update_user_meta($wp_user_id, $this->build_meta_key($product), sanitize_text_field($data['uuid']));

        // The app token is baked into the GRND, so their lifecycles are
        // coupled: a cached GRND issued over the previous (now revoked)
        // password must never be reused. Invalidate it in the same call.
        (new TokenManager())->forget($wp_user_id, $product);

        return $data['password'];
    }

    /**
     * Revoke the stored Application Password for a (user, product) pair and
     * remove the uuid from user meta.
     *
     * Called during force-new re-auth (after a 401) and during GDPR erasure.
     *
     * @param int    $wp_user_id WordPress user ID.
     * @param string $product    Product slug.
     *
     * @return void
     */
    public function delete_stored_password(int $wp_user_id, string $product): void
    {
        $this->revoke_previous($wp_user_id, $product);

        // A GRND issued over the revoked password is dead weight — drop it so
        // the next auth cycle provisions both credentials fresh.
        (new TokenManager())->forget($wp_user_id, $product);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Revoke the previously stored Application Password via the WP REST API and
     * delete its uuid from user meta.
     *
     * @param int    $wp_user_id WordPress user ID.
     * @param string $product    Product slug.
     *
     * @return void
     */
    private function revoke_previous(int $wp_user_id, string $product): void
    {
        $uuid = get_user_meta($wp_user_id, $this->build_meta_key($product), true);
        if (!$uuid || !is_string($uuid)) {
            return;
        }

        $request = new \WP_REST_Request(
            'DELETE',
            "/wp/v2/users/{$wp_user_id}/application-passwords/{$uuid}"
        );
        rest_do_request($request);

        delete_user_meta($wp_user_id, $this->build_meta_key($product));
    }

    /**
     * Build the user meta key for storing a product's App Password uuid.
     *
     * @param string $product Product slug.
     *
     * @return string User meta key.
     */
    private function build_meta_key(string $product): string
    {
        return self::META_KEY_PREFIX . sanitize_key($product);
    }
}
