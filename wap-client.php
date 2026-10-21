<?php
/**
 * Plugin Name:       WAP Client
 * Plugin URI:        https://github.com/group-one/wap-client
 * Description:       WordPress AI Platform (WAP) client library. Integrates the WAP AI chat assistant into any WordPress plugin via a single static method call.
 * Version:           2.4.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Group.one
 * Author URI:        https://www.group.one
 * License:           GPL-2.0-or-later
 * License URI:       https://spdx.org/licenses/GPL-2.0-or-later.html
 * Text Domain:       wap-client
 */

declare(strict_types=1);

// return, not exit: Composer autoloads this file, and exit would end PHPUnit/PHPCS/PHPStan runs in consumers.
if (!defined('ABSPATH')) {
    return;
}

// ---------------------------------------------------------------------------
// Autoloader — PSR-4 via Composer, or manual fallback for non-Composer installs.
// ---------------------------------------------------------------------------

if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    require_once __DIR__ . '/vendor/autoload.php';
} else {
    // Manual class map fallback when Composer is not available.
    $class_map = [
        'GroupOne\\WapClient\\AppPasswordManager'       => __DIR__ . '/includes/class-app-password-manager.php',
        'GroupOne\\WapClient\\AppPasswordGuard'         => __DIR__ . '/includes/class-app-password-guard.php',
        'GroupOne\\WapClient\\AppPasswordScopeEnforcer' => __DIR__ . '/includes/class-app-password-scope-enforcer.php',
        'GroupOne\\WapClient\\ChatColumn'               => __DIR__ . '/includes/class-chat-column.php',
        'GroupOne\\WapClient\\ChatEmbed'                => __DIR__ . '/includes/class-chat-embed.php',
        'GroupOne\\WapClient\\ChatWidget'               => __DIR__ . '/includes/class-chat-widget.php',
        'GroupOne\\WapClient\\ScreenTarget'             => __DIR__ . '/includes/class-screen-target.php',
        'GroupOne\\WapClient\\ConsentGate'              => __DIR__ . '/includes/class-consent-gate.php',
        'GroupOne\\WapClient\\GdprHandler'              => __DIR__ . '/includes/class-gdpr-handler.php',
        'GroupOne\\WapClient\\GrndService'              => __DIR__ . '/includes/class-grnd-service.php',
        'GroupOne\\WapClient\\GrndProviderInterface'    => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\LicenseGrndProvider'      => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\CallableGrndProvider'     => __DIR__ . '/includes/class-grnd-provider.php',
        'GroupOne\\WapClient\\TokenManager'             => __DIR__ . '/includes/class-token-manager.php',
        'GroupOne\\WapClient\\TokenSealer'              => __DIR__ . '/includes/class-token-sealer.php',
        'GroupOne\\WapClient\\WrapKeyClient'            => __DIR__ . '/includes/class-wrap-key-client.php',
    ];

    spl_autoload_register(static function (string $class) use ($class_map): void {
        if (isset($class_map[$class])) {
            require_once $class_map[$class];
        }
    });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

define('WAP_CLIENT_VERSION', '2.4.0');
define('WAP_CLIENT_FILE', __FILE__);
define('WAP_CLIENT_DIR', plugin_dir_path(__FILE__));
define('WAP_CLIENT_URL', plugin_dir_url(__FILE__));

// ---------------------------------------------------------------------------
// Activation / deactivation hooks
// ---------------------------------------------------------------------------

register_activation_hook(__FILE__, 'wap_client_activate');
register_deactivation_hook(__FILE__, 'wap_client_deactivate');

// Declarations live in their own file, required only past the guard: PHP declares a file's top-level
// classes and functions at compile time, so here they would exist even without WordPress.
require_once __DIR__ . '/wap-client-api.php';
