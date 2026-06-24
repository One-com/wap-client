<?php
/**
 * Plugin Name: WAP Test Client
 * Description: Dev test client for the WordPress AI Platform (WAP). Adds a chat interface to WP Admin for testing the WAP API.
 * Version:     0.1.0
 * Author:      Mathieu Lamiot
 */

defined( 'ABSPATH' ) || exit;

define( 'WAP_TEST_DIR', plugin_dir_path( __FILE__ ) );
define( 'WAP_TEST_URL', plugin_dir_url( __FILE__ ) );

// Load the wap-client library (provides WapClient, AppPasswordManager, etc.)
if ( ! defined( 'WAP_CLIENT_DEV_MODE' ) ) {
	define( 'WAP_CLIENT_DEV_MODE', true ); // Allow App Passwords over HTTP in local dev.
}
require_once WP_PLUGIN_DIR . '/wap-client/wap-client.php';

// ---------------------------------------------------------------------------
// Admin menu
// ---------------------------------------------------------------------------

add_action( 'admin_menu', 'wap_test_admin_menu' );

function wap_test_admin_menu() {
	add_menu_page(
		'WAP Test Client',
		'WAP Test',
		'manage_options',
		'wap-test-client',
		'wap_test_render_chat',
		'dashicons-format-chat',
		80
	);
	add_submenu_page(
		'wap-test-client',
		'Chat',
		'Chat',
		'manage_options',
		'wap-test-client',
		'wap_test_render_chat'
	);
	add_submenu_page(
		'wap-test-client',
		'Settings',
		'Settings',
		'manage_options',
		'wap-test-settings',
		'wap_test_render_settings'
	);
}

function wap_test_render_chat() {
	include WAP_TEST_DIR . 'admin/chat.php';
}

function wap_test_render_settings() {
	include WAP_TEST_DIR . 'admin/settings.php';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

add_action( 'admin_init', 'wap_test_register_settings' );

function wap_test_register_settings() {
	register_setting( 'wap_test_group', 'wap_test_options', [
		'sanitize_callback' => 'wap_test_sanitize_options',
		'default'           => [
			'wap_url'         => 'http://localhost:3000',
			'wap_browser_url' => '',
			'product'         => 'wp-rocket',
			'license_key'     => '',
			'mode'            => 'product',
			'mcp_endpoint'    => home_url( '/wp-json/mcp/mcp-adapter-default-server' ),
			'page_context'    => '',
		],
	] );
}

function wap_test_sanitize_options( $input ) {
	$clean = [];
	$clean['wap_url']         = isset( $input['wap_url'] ) ? esc_url_raw( trim( $input['wap_url'] ) ) : 'http://localhost:3000';
	$clean['wap_browser_url'] = isset( $input['wap_browser_url'] ) ? esc_url_raw( trim( $input['wap_browser_url'] ) ) : '';
	$clean['product']         = isset( $input['product'] ) ? sanitize_text_field( $input['product'] ) : 'wp-rocket';
	$clean['license_key']     = isset( $input['license_key'] ) ? sanitize_text_field( $input['license_key'] ) : '';
	$clean['mode']            = in_array( $input['mode'] ?? '', [ 'product', 'orchestrator' ], true ) ? $input['mode'] : 'product';
	$clean['mcp_endpoint']    = isset( $input['mcp_endpoint'] ) && $input['mcp_endpoint']
		? esc_url_raw( trim( $input['mcp_endpoint'] ) )
		: home_url( '/wp-json/mcp/mcp-adapter-default-server' );
	$clean['page_context']   = isset( $input['page_context'] ) ? sanitize_key( $input['page_context'] ) : '';
	return $clean;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

add_action( 'admin_enqueue_scripts', 'wap_test_enqueue' );

function wap_test_enqueue( $hook ) {
	if ( false === strpos( $hook, 'wap-test' ) ) {
		return;
	}

	$opts = wp_parse_args( get_option( 'wap_test_options', [] ), [
		'wap_url'         => 'http://localhost:3000',
		'wap_browser_url' => '',
		'mode'            => 'product',
		'page_context'    => '',
		'product'         => 'wp-rocket',
	] );

	// Browser URL falls back to wap_url when not set (same-machine setups).
	$browser_url = ! empty( $opts['wap_browser_url'] ) ? $opts['wap_browser_url'] : $opts['wap_url'];

	wp_enqueue_style( 'wap-test-css', WAP_TEST_URL . 'assets/chat.css', [], '0.1.0' );
	wp_enqueue_script( 'wap-test-js', WAP_TEST_URL . 'assets/chat.js', [], '0.1.0', true );

	wp_localize_script( 'wap-test-js', 'WapTest', [
		'ajaxUrl'     => admin_url( 'admin-ajax.php' ),
		'nonce'       => wp_create_nonce( 'wap_test_auth' ),
		'wapUrl'      => rtrim( $browser_url, '/' ),
		'mode'        => $opts['mode'],
		'pageContext' => $opts['page_context'] ?? '',
	] );
}

// ---------------------------------------------------------------------------
// AJAX: authenticate against WAP server (server-side, avoids browser CORS)
// ---------------------------------------------------------------------------

add_action( 'wp_ajax_wap_test_auth', 'wap_test_ajax_auth' );

function wap_test_ajax_auth() {
	check_ajax_referer( 'wap_test_auth' );

	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( [ 'message' => 'Insufficient permissions' ], 403 );
	}

	$opts = get_option( 'wap_test_options', [] );

	if ( empty( $opts['wap_url'] ) ) {
		wp_send_json_error( [ 'message' => 'WAP server URL not configured. Go to WAP Test → Settings.' ], 400 );
	}

	$current_user = wp_get_current_user();
	$product      = $opts['product'] ?? 'wp-rocket';

	// On re-auth after a 401, revoke the stored App Password so a fresh one is provisioned.
	if ( ! empty( $_POST['force_new'] ) ) {
		$mgr = new \GroupOne\WapClient\AppPasswordManager();
		$mgr->delete_stored_password( $current_user->ID, $product );
	}

	$result = \WapClient::get_session_token(
		$current_user->ID,
		$product,
		[
			'server_url'    => rtrim( $opts['wap_url'], '/' ),
			'product'       => $product,
			'product_label' => $product,
			'license_key'   => $opts['license_key'] ?? '',
			'site_url'      => home_url(),
			'mcp_endpoint'  => $opts['mcp_endpoint'] ?? home_url( '/wp-json/mcp/mcp-adapter-default-server' ),
			'mode'          => $opts['mode'] ?? 'product',
		]
	);

	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ], 502 );
	}

	wp_send_json_success( [
		'token' => $result['token'] ?? '',
		'agent' => $result['agent'] ?? null,
		'mode'  => $result['mode']  ?? ( $opts['mode'] ?? 'product' ),
	] );
}
