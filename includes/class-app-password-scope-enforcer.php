<?php
/**
 * App Password Scope Enforcer — hard-cutoff expiry and MCP-only scope for
 * WAP-issued Application Passwords, via WordPress's own `rest_authentication_errors`
 * filter. See docs/consent-and-credential-flow.md#43-enforcement for the full rationale.
 *
 * @package GroupOne\WapClient
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

defined('ABSPATH') || exit;

/**
 * Enforces expiry and MCP-only scope for WAP-managed Application Passwords.
 */
final class AppPasswordScopeEnforcer
{
    /**
     * Register the enforcement hook. Priority 101: runs after WP core's own
     * auth checks (90, 100), so $result already reflects whichever method ran.
     */
    public static function register(): void
    {
        add_filter('rest_authentication_errors', [self::class, 'check'], 101);
    }

    /**
     * rest_authentication_errors callback.
     *
     * @param mixed $result Whatever the auth pipeline has produced so far:
     *                      true/null on no error yet, or a WP_Error.
     *
     * @return mixed Unchanged, or a WP_Error refusing the request.
     */
    public static function check($result)
    {
        if (is_wp_error($result)) {
            // Another auth method already failed — nothing to add.
            return $result;
        }

        if (!function_exists('rest_get_authenticated_app_password')) {
            // WP core too old to support Application Passwords at all.
            return $result;
        }

        $uuid = rest_get_authenticated_app_password();
        if (!$uuid) {
            // Not authenticated via an Application Password — not this class's concern.
            return $result;
        }

        $wp_user_id = get_current_user_id();
        if (!$wp_user_id) {
            return $result;
        }

        $product = AppPasswordGuard::product_for_uuid($wp_user_id, $uuid);
        if (null === $product) {
            // Not one WAP minted — leave it to whatever else the site does.
            return $result;
        }

        if (AppPasswordGuard::is_expired($wp_user_id, $product)) {
            return new \WP_Error(
                'wap_app_password_expired',
                __('This Application Password has expired.', 'wap-client'),
                ['status' => 401]
            );
        }

        if (!self::is_mcp_endpoint_request()) {
            return new \WP_Error(
                'wap_app_password_scope',
                __('This Application Password may only be used on the MCP endpoint.', 'wap-client'),
                ['status' => 403]
            );
        }

        return $result;
    }

    /**
     * Whether the current request's REST route matches this site's
     * configured MCP endpoint (ChatWidget::mcp_endpoint_url()).
     */
    private static function is_mcp_endpoint_request(): bool
    {
        $route = $GLOBALS['wp']->query_vars['rest_route'] ?? null;
        if (!is_string($route) || '' === $route) {
            return false;
        }
        $route = untrailingslashit($route);

        $mcp_url  = ChatWidget::mcp_endpoint_url();
        $mcp_path = wp_parse_url($mcp_url, PHP_URL_PATH);
        if (!is_string($mcp_path) || '' === $mcp_path) {
            return false;
        }

        $prefix    = '/' . rest_get_url_prefix();
        $mcp_route = str_starts_with($mcp_path, $prefix)
            ? substr($mcp_path, strlen($prefix))
            : $mcp_path;
        $mcp_route = untrailingslashit($mcp_route);

        return $route === $mcp_route;
    }
}
