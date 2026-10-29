<?php
/**
 * App Password Scope Enforcer — hard-cutoff expiry and MCP-only scope for
 * WAP-issued Application Passwords, via WordPress's own
 * `wp_authenticate_application_password_errors` action. See
 * docs/consent-and-credential-flow.md#43-enforcement for the full rationale.
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
     * Register the enforcement hook. It fires on every successful Application
     * Password check (REST and XML-RPC alike); 3 args so the raw password never reaches us.
     */
    public static function register(): void
    {
        add_action('wp_authenticate_application_password_errors', [self::class, 'check'], 10, 3);
    }

    /**
     * wp_authenticate_application_password_errors callback: adding an error
     * makes core fail the authentication, so no user is ever set.
     *
     * @param \WP_Error $error Errors collected so far; core refuses the login if non-empty.
     * @param \WP_User  $user  The user whose password just matched.
     * @param array     $item  The matched Application Password record.
     */
    public static function check(\WP_Error $error, \WP_User $user, array $item): void
    {
        if ($error->has_errors()) {
            // Already refused by someone else — nothing to add.
            return;
        }

        $uuid = $item['uuid'] ?? '';
        if (!is_string($uuid) || '' === $uuid) {
            return;
        }

        $product = AppPasswordGuard::product_for_uuid($user->ID, $uuid);
        if (null === $product) {
            // Not one WAP minted — leave it to whatever else the site does.
            return;
        }

        if (AppPasswordGuard::is_expired($user->ID, $product)) {
            $error->add(
                'wap_app_password_expired',
                __('This Application Password has expired.', 'wap-client'),
                ['status' => 401]
            );
            return;
        }

        if (!self::is_mcp_endpoint_request()) {
            $error->add(
                'wap_app_password_scope',
                __('This Application Password may only be used on the MCP endpoint.', 'wap-client'),
                ['status' => 403]
            );
        }
    }

    /**
     * Whether the current request is a REST request to this site's configured
     * MCP endpoint (ChatWidget::mcp_endpoint_url()).
     */
    private static function is_mcp_endpoint_request(): bool
    {
        if (!defined('REST_REQUEST') || !REST_REQUEST) {
            // XML-RPC or any other context core accepts Application Passwords in.
            return false;
        }

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
