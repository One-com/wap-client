<?php
/**
 * API Client — HTTP client for WAP backend calls.
 *
 * Handles all outbound HTTP requests from the WordPress plugin to the WAP
 * FastAPI backend. Uses wp_remote_post / wp_remote_get so requests respect
 * WordPress HTTP proxy settings and SSL verification configuration.
 *
 * @package Groupone\WapClient
 */

declare(strict_types=1);

namespace Groupone\WapClient;

defined('ABSPATH') || exit;

/**
 * HTTP client for the WAP REST API.
 *
 * All methods return an associative array on success or a WP_Error on failure.
 * HTTP 4xx/5xx responses are normalised into WP_Error with an appropriate code.
 */
class ApiClient
{
    /**
     * WAP backend base URL (without trailing slash).
     *
     * @var string
     */
    private string $base_url;

    /**
     * Default HTTP timeout in seconds for non-streaming requests.
     *
     * @var int
     */
    private const TIMEOUT = 15;

    /**
     * Constructor.
     *
     * @param string $base_url WAP backend URL, e.g. 'https://wap.group.one'.
     *                         Trailing slash is stripped automatically.
     */
    public function __construct(string $base_url)
    {
        $this->base_url = apply_filters('wap_client_server_url', rtrim($base_url, '/'));
    }

    // -------------------------------------------------------------------------
    // Auth endpoints
    // -------------------------------------------------------------------------

    /**
     * Create a WAP session by calling POST /api/v1/auth/session.
     *
     * @param array{
     *     product:              string,
     *     license_key?:         string,
     *     site_url?:            string,
     *     wp_username:          string,
     *     wp_app_password:      string,
     *     mcp_endpoint?:        string,
     *     mode?:                string,
     *     available_products?:  string[],
     * } $args Session creation arguments.
     *
     * @return array|\WP_Error Decoded JSON body on success, WP_Error on failure.
     */
    public function create_session(array $args)
    {
        $payload = [
            'product'            => $args['product'] ?? '',
            'license_key'        => $args['license_key'] ?? '',
            'site_url'           => $args['site_url'] ?? home_url(),
            'wp_username'        => $args['wp_username'] ?? '',
            'wp_app_password'    => $args['wp_app_password'] ?? '',
            'mcp_endpoint'       => $args['mcp_endpoint'] ?? home_url('/wp-json/mcp/mcp-adapter-default-server'),
            'mode'               => $args['mode'] ?? 'product',
            'available_products' => $args['available_products'] ?? [$args['product'] ?? ''],
        ];

        return $this->post('/api/v1/auth/session', $payload);
    }

    /**
     * Revoke the current WAP session by calling DELETE /api/v1/auth/session.
     *
     * @param string $session_token Current Bearer token.
     *
     * @return true|\WP_Error True on success (204 No Content), WP_Error on failure.
     */
    public function delete_session(string $session_token)
    {
        $url      = $this->base_url . '/api/v1/auth/session';
        $response = wp_remote_request($url, [
            'method'  => 'DELETE',
            'headers' => [
                'Authorization' => 'Bearer ' . $session_token,
                'Content-Type'  => 'application/json',
            ],
            'timeout' => self::TIMEOUT,
        ]);

        if (is_wp_error($response)) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);

        // 204 No Content is the expected success response.
        if (204 === $status || 200 === $status) {
            return true;
        }

        return $this->error_from_response($response, $status);
    }

    // -------------------------------------------------------------------------
    // Chat endpoints
    // -------------------------------------------------------------------------

    /**
     * Retrieve conversation history for a thread.
     *
     * Calls GET /api/v1/chat/{conversation_id}/history.
     *
     * @param string $conversation_id LangGraph thread_id (format: "{user_id}:{role}").
     * @param string $session_token   Current Bearer token.
     *
     * @return array|\WP_Error Decoded history array on success, WP_Error on failure.
     */
    public function get_history(string $conversation_id, string $session_token)
    {
        $url      = $this->base_url . '/api/v1/chat/' . rawurlencode($conversation_id) . '/history';
        $response = wp_remote_get($url, [
            'headers' => [
                'Authorization' => 'Bearer ' . $session_token,
                'Accept'        => 'application/json',
            ],
            'timeout' => self::TIMEOUT,
        ]);

        if (is_wp_error($response)) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);

        if ($status < 200 || $status >= 300) {
            return $this->error_from_response($response, $status);
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        return is_array($body) ? $body : [];
    }

    // -------------------------------------------------------------------------
    // GDPR endpoints
    // -------------------------------------------------------------------------

    /**
     * Request deletion of all user data from the WAP backend.
     *
     * Calls DELETE /api/v1/me/data. Implements US12 (GDPR / right to erasure).
     * Called server-side by GdprHandler — the token transits through PHP memory
     * only and is never stored in WordPress.
     *
     * @param string $session_token Current Bearer token.
     *
     * @return true|\WP_Error True on success (204 No Content), WP_Error on failure.
     */
    public function delete_user_data(string $session_token)
    {
        $url      = $this->base_url . '/api/v1/me/data';
        $response = wp_remote_request($url, [
            'method'  => 'DELETE',
            'headers' => [
                'Authorization' => 'Bearer ' . $session_token,
            ],
            'timeout' => self::TIMEOUT,
        ]);

        if (is_wp_error($response)) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);

        if (204 === $status || 200 === $status) {
            return true;
        }

        return $this->error_from_response($response, $status);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * POST JSON payload to a WAP endpoint.
     *
     * @param string $path    API path (e.g. '/api/v1/auth/session').
     * @param array  $payload Data to JSON-encode as the request body.
     * @param string $token   Optional Bearer token for authenticated endpoints.
     *
     * @return array|\WP_Error Decoded JSON on success, WP_Error on failure.
     */
    private function post(string $path, array $payload, string $token = '')
    {
        $headers = ['Content-Type' => 'application/json'];
        if ($token) {
            $headers['Authorization'] = 'Bearer ' . $token;
        }

        $response = wp_remote_post($this->base_url . $path, [
            'headers' => $headers,
            'body'    => wp_json_encode($payload),
            'timeout' => self::TIMEOUT,
        ]);

        if (is_wp_error($response)) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);

        if ($status < 200 || $status >= 300) {
            return $this->error_from_response($response, $status);
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        return is_array($body) ? $body : [];
    }

    /**
     * Build a WP_Error from an HTTP response with a non-success status code.
     *
     * Includes the HTTP status code, the JSON error message if available,
     * and raw body for debugging.
     *
     * @param array|\WP_Error $response wp_remote_* response.
     * @param int             $status   HTTP status code.
     *
     * @return \WP_Error
     */
    private function error_from_response($response, int $status): \WP_Error
    {
        $raw  = wp_remote_retrieve_body($response);
        $body = json_decode($raw, true);

        // FastAPI wraps errors as {"detail": {"error": "…", "message": "…"}}.
        // Fall back to top-level "message" for non-FastAPI responses.
        $detail  = is_array($body) && isset($body['detail']) && is_array($body['detail']) ? $body['detail'] : [];
        $message = (isset($detail['message']) && is_string($detail['message']))
            ? $detail['message']
            : (isset($body['message']) && is_string($body['message']) ? $body['message'] : null);
        $message = $message ?? sprintf(
                /* translators: 1: HTTP status code */
                __('WAP API request failed (HTTP %d).', 'wap-client'),
                $status
            );

        $error_code = 'wap_api_error_' . $status;

        // Map well-known codes to semantic error codes.
        if (401 === $status) {
            $error_code = 'wap_unauthorized';
        } elseif (403 === $status) {
            $error_code = 'wap_license_invalid';
        } elseif (429 === $status) {
            $error_code = 'wap_rate_limited';
        }

        return new \WP_Error($error_code, $message, ['status' => $status, 'body' => $raw]);
    }
}
