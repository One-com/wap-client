<?php
/**
 * Standalone unit tests for the public WapClient facade's embed API (WPIN-8839).
 *
 * No PHPUnit dependency — run directly:
 *     php tests/test-facade-embed.php
 *
 * Exits 0 when all assertions pass, 1 otherwise.
 *
 * Unlike test-chat-embed.php, which drives ChatEmbed directly, this loads the
 * real wap-client.php entry point. That is deliberate: it exercises the manual
 * class-map autoloader, the constants, the boot hooks and the Application
 * Password gate — the exact path an integrating plugin takes, and the one place
 * a missing classmap entry or a renamed facade method would go unnoticed.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

error_reporting(E_ALL);

define('ABSPATH', '/');

// -----------------------------------------------------------------------------
// Minimal WordPress shims
// -----------------------------------------------------------------------------

$GLOBALS['wap_hooks']     = [];
$GLOBALS['wap_styles']    = [];
$GLOBALS['wap_scripts']   = [];
$GLOBALS['wap_localized'] = [];
$GLOBALS['wap_menus']     = [];
$GLOBALS['wap_can']       = true;
$GLOBALS['wap_screen']    = null;
// Drives AppPasswordManager::are_app_passwords_available() via is_ssl(). Left
// controllable (rather than defining WAP_CLIENT_DEV_MODE, which short-circuits
// the check) so both the allow and the refuse path can be covered in one run.
$GLOBALS['wap_ssl']       = true;

function add_action(string $h, $cb, int $p = 10, int $a = 1): bool
{
    $GLOBALS['wap_hooks'][$h][] = ['cb' => $cb, 'p' => $p];
    return true;
}

function add_filter(string $h, $cb, int $p = 10, int $a = 1): bool
{
    return add_action($h, $cb, $p, $a);
}

function has_action(string $h): bool
{
    return !empty($GLOBALS['wap_hooks'][$h]);
}

/** Fires in priority order, as WordPress does — embed/column precedence relies on it. */
function do_action(string $h, ...$args): void
{
    $cbs = $GLOBALS['wap_hooks'][$h] ?? [];
    usort($cbs, static fn (array $x, array $y): int => $x['p'] <=> $y['p']);
    foreach ($cbs as $e) {
        ($e['cb'])(...$args);
    }
}

function apply_filters(string $h, $v, ...$args)
{
    $cbs = $GLOBALS['wap_hooks'][$h] ?? [];
    usort($cbs, static fn (array $x, array $y): int => $x['p'] <=> $y['p']);
    foreach ($cbs as $e) {
        $v = ($e['cb'])($v, ...$args);
    }
    return $v;
}

function register_activation_hook(string $f, $cb): void
{
}

function register_deactivation_hook(string $f, $cb): void
{
}

function plugin_dir_path(string $f): string
{
    return dirname($f) . '/';
}

function plugin_dir_url(string $f): string
{
    return 'https://customer-site.test/wp-content/plugins/my-plugin/vendor/groupone/wap-client/';
}

function plugin_basename(string $f): string
{
    return 'wap-client/wap-client.php';
}

function load_plugin_textdomain(string $d, $x = false, string $p = ''): bool
{
    return true;
}

function is_ssl(): bool
{
    return (bool) $GLOBALS['wap_ssl'];
}

/**
 * Mirrors real WordPress (5.6+): defaults to is_ssl(), but is independently
 * filterable — a security plugin can disable Application Passwords outright,
 * regardless of SSL. $GLOBALS['wap_app_passwords_available'] lets a test
 * simulate that override; unset, it falls back to is_ssl() like core does.
 */
function wp_is_application_passwords_available(): bool
{
    return $GLOBALS['wap_app_passwords_available'] ?? is_ssl();
}

function current_user_can(string $c): bool
{
    return (bool) $GLOBALS['wap_can'];
}

function get_role(string $r)
{
    return null;
}

function add_menu_page(
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = '',
    string $icon_url = '',
    ?int $position = null
) {
    $GLOBALS['wap_menus'][] = $menu_slug;
    return 'toplevel_page_' . $menu_slug;
}

function add_submenu_page(
    string $parent_slug,
    string $page_title,
    string $menu_title,
    string $capability,
    string $menu_slug,
    $callback = ''
) {
    $GLOBALS['wap_menus'][] = $menu_slug;
    return ('' === $parent_slug ? 'admin_page_' : $parent_slug . '_page_') . $menu_slug;
}

function wp_enqueue_style(string $h, string $s = '', array $d = [], $v = null): void
{
    $GLOBALS['wap_styles'][$h] = $s;
}

function wp_enqueue_script(string $h, string $s = '', array $d = [], $v = null, bool $f = false): void
{
    $GLOBALS['wap_scripts'][$h] = ['src' => $s, 'footer' => $f];
}

function wp_localize_script(string $h, string $o, array $d): bool
{
    $GLOBALS['wap_localized'][$h][$o] = $d;
    return true;
}

function sanitize_key(string $k): string
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower($k));
}

function sanitize_html_class(string $c): string
{
    return preg_replace('/[^A-Za-z0-9_-]/', '', $c);
}

function sanitize_text_field(string $s): string
{
    return trim(strip_tags($s));
}

function esc_url_raw(string $u): string
{
    return $u;
}

function esc_attr(string $t): string
{
    return htmlspecialchars($t, ENT_QUOTES, 'UTF-8');
}

function esc_html(string $t): string
{
    return htmlspecialchars($t, ENT_QUOTES, 'UTF-8');
}

function esc_js(string $t): string
{
    return $t;
}

function __(string $t, string $d = 'default'): string
{
    return $t;
}

function esc_html__(string $t, string $d = 'default'): string
{
    return esc_html($t);
}

function esc_html_e(string $t, string $d = 'default'): void
{
    echo esc_html($t);
}

function _doing_it_wrong(string $f, string $m, string $v): void
{
    $GLOBALS['wap_doing_it_wrong'][] = $m;
}

function home_url(string $p = ''): string
{
    return 'https://customer-site.test' . $p;
}

function admin_url(string $p = ''): string
{
    return 'https://customer-site.test/wp-admin/' . $p;
}

function wp_create_nonce(string $a = ''): string
{
    return 'nonce-' . $a;
}

function get_option(string $o, $d = false)
{
    return 'SECRET-LICENSE';
}

function get_bloginfo(string $s = ''): string
{
    return 'UTF-8';
}

function determine_locale(): string
{
    return 'en_US';
}

function wp_unslash($v)
{
    return $v;
}

function get_current_screen()
{
    return $GLOBALS['wap_screen'];
}

function get_user_meta(int $u, string $k, bool $s = false)
{
    return '';
}

function update_user_meta(int $u, string $k, $v): bool
{
    return true;
}

function wp_kses_post(string $s): string
{
    return $s;
}

function wp_get_current_user()
{
    return new class {
        public int $ID = 7;
        public string $display_name = 'Ada';
        public string $user_login   = 'ada';

        public function exists(): bool
        {
            return true;
        }
    };
}

// The real entry point — constants, class-map autoloader, boot hooks, facade.
require_once __DIR__ . '/../wap-client.php';

use GroupOne\WapClient\ChatEmbed;
use GroupOne\WapClient\ChatWidget;

// -----------------------------------------------------------------------------
// Test harness
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

/**
 * setAccessible() has been a no-op since PHP 8.1 and is deprecated in 8.5, but
 * is still required on the PHP 7.4 floor the package supports.
 *
 * @param ReflectionProperty $ref
 */
function unlock($ref)
{
    if (PHP_VERSION_ID < 80100) {
        $ref->setAccessible(true);
    }
    return $ref;
}

function private_prop(string $class, string $name): ReflectionProperty
{
    return unlock(new ReflectionProperty($class, $name));
}

function reset_state(): void
{
    $GLOBALS['wap_hooks']          = [];
    $GLOBALS['wap_styles']         = [];
    $GLOBALS['wap_scripts']        = [];
    $GLOBALS['wap_localized']      = [];
    $GLOBALS['wap_menus']          = [];
    $GLOBALS['wap_can']            = true;
    $GLOBALS['wap_screen']         = null;
    $GLOBALS['wap_ssl']            = true;
    $GLOBALS['wap_doing_it_wrong'] = [];
    unset($GLOBALS['wap_app_passwords_available']);

    private_prop(ChatWidget::class, 'pages')->setValue(null, []);
    private_prop(ChatWidget::class, 'screen_owner')->setValue(null, '');
    private_prop(ChatEmbed::class, 'embeds')->setValue(null, []);
    private_prop(ChatEmbed::class, 'active')->setValue(null, []);
    private_prop(ChatEmbed::class, 'emitted')->setValue(null, []);
}

/**
 * @return array<string, mixed> The RankMath-shaped registration from the ticket.
 */
function embed_args(array $overrides = []): array
{
    return array_merge([
        'id'         => 'content-ai',
        'product'    => 'rank-math',
        'server_url' => 'https://wap.group.one',
        'grnd'       => [
            'issuer_url'  => 'https://api.rankmath.com/grnd/token',
            'license_key' => get_option('rank_math_license'),
        ],
        'screens'    => ['rank-math_page_rank-math-content-ai', 'post'],
        'layout'     => ['height' => '640px'],
    ], $overrides);
}

function widget_config(string $id): array
{
    return $GLOBALS['wap_localized']['wap-client-chat-' . $id]['WapClientConfig'] ?? [];
}

// -----------------------------------------------------------------------------
// The facade surface
// -----------------------------------------------------------------------------

echo "\nFacade surface\n";

check('WapClient::register_chat_embed exists', method_exists('WapClient', 'register_chat_embed'));
check('WapClient::render_chatbox exists', method_exists('WapClient', 'render_chatbox'));
check('WapClient::get_chatbox exists', method_exists('WapClient', 'get_chatbox'));
check('WapClient::has_chatbox exists', method_exists('WapClient', 'has_chatbox'));

// A missing class-map entry would only ever surface here — the other suites
// require the class files directly.
check('ChatEmbed resolves through the class-map autoloader', class_exists('GroupOne\WapClient\ChatEmbed'));
check('ScreenTarget resolves through the class-map autoloader', class_exists('GroupOne\WapClient\ScreenTarget'));

// -----------------------------------------------------------------------------
// Registration through the facade
// -----------------------------------------------------------------------------

echo "\nRegistration through the facade\n";

reset_state();
\WapClient::register_chat_embed(embed_args());
check('the embed registers a surface', !empty(private_prop(ChatWidget::class, 'pages')->getValue()['content-ai'] ?? []));
check('the embed registers no admin_menu hook', !has_action('admin_menu'));

do_action('admin_menu');
check('no menu or submenu page is added', [] === $GLOBALS['wap_menus']);

// WPIN-9065: the embed stays registered even when Application Passwords are
// unavailable — the widget mount point is replaced with a contextual notice
// on the embedding screen itself, rather than the surface vanishing and the
// reason only ever surfacing in a site-wide admin_notices banner.
reset_state();
$GLOBALS['wap_ssl'] = false;
\WapClient::register_chat_embed(embed_args());
check(
    'the embed still registers a surface when Application Passwords are unavailable',
    !empty(private_prop(ChatWidget::class, 'pages')->getValue()['content-ai'] ?? [])
);

do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
check('has_chatbox() is still true — the surface renders a notice, not nothing', \WapClient::has_chatbox('content-ai'));

$unavailable_html = \WapClient::get_chatbox('content-ai');
check('get_chatbox() renders the unavailable notice instead of the mount point', false !== strpos($unavailable_html, 'wap-client-unavailable-notice'));
check('the notice contains no widget mount point', false === strpos($unavailable_html, 'id="wap-chat-embed-root-content-ai"'));
check('a non-HTTPS site is told HTTPS is required', false !== strpos($unavailable_html, 'requires HTTPS'));

// A distinct message when Application Passwords are disabled independent of
// HTTPS (e.g. by a security plugin) — the bug this ticket fixes.
reset_state();
$GLOBALS['wap_ssl'] = true;
$GLOBALS['wap_app_passwords_available'] = false;
\WapClient::register_chat_embed(embed_args());
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
$disabled_html = \WapClient::get_chatbox('content-ai');
check('an HTTPS site with Application Passwords disabled gets a different message', false === strpos($disabled_html, 'requires HTTPS'));
check('the disabled-not-https message names Application Passwords', false !== strpos($disabled_html, 'Application Passwords have been disabled'));
unset($GLOBALS['wap_app_passwords_available']);

// -----------------------------------------------------------------------------
// Rendering through the facade
// -----------------------------------------------------------------------------

echo "\nRendering through the facade\n";

reset_state();
\WapClient::register_chat_embed(embed_args());
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');

check('assets load on the opted-in screen', isset($GLOBALS['wap_scripts']['wap-client-chat-content-ai']));
check('the widget script loads in the footer', true === ($GLOBALS['wap_scripts']['wap-client-chat-content-ai']['footer'] ?? null));
check('has_chatbox() is true there', \WapClient::has_chatbox('content-ai'));

$cfg = widget_config('content-ai');
check('cfg.root targets the namespaced mount point', '#wap-chat-embed-root-content-ai' === ($cfg['root'] ?? null));
check('cfg.column is null, so no panel chrome is built', array_key_exists('column', $cfg) && null === $cfg['column']);
check('an explicit layout height reaches the widget', '640px' === ($cfg['layout']->height ?? null));
check('the embed width default reaches the widget', 'fluid' === ($cfg['layout']->width ?? null));
check('cfg.menuSlug lets ajax_auth resolve the surface', 'content-ai' === ($cfg['menuSlug'] ?? null));

$html = \WapClient::get_chatbox('content-ai');
check('get_chatbox() returns the mount point', false !== strpos($html, 'id="wap-chat-embed-root-content-ai"'));
check('get_chatbox() emits no column wrapper', false === strpos($html, 'data-wap-chat-column'));

// The two helpers share one per-screen budget: only a single mount point can
// work, so having taken the markup above, render_chatbox() must not emit a
// duplicate with the same DOM id.
ob_start();
\WapClient::render_chatbox('content-ai');
check('render_chatbox() after get_chatbox() emits no duplicate', '' === trim((string) ob_get_clean()));

// …and on a fresh request the echoing path produces exactly the same markup.
reset_state();
\WapClient::register_chat_embed(embed_args());
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
ob_start();
\WapClient::render_chatbox('content-ai');
$echoed = (string) ob_get_clean();
check('render_chatbox() echoes the mount point', false !== strpos($echoed, 'id="wap-chat-embed-root-content-ai"'));
check('render_chatbox() output matches get_chatbox() on an equivalent request', $echoed === $html);

// An id that only differs by case/format still resolves — registration
// sanitises it, so the lookups must too.
reset_state();
\WapClient::register_chat_embed(embed_args(['id' => 'Content_AI']));
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
check('a non-normalised id still resolves on lookup', \WapClient::has_chatbox('Content_AI'));
check('a non-normalised id still renders', '' !== \WapClient::get_chatbox('Content_AI'));

// Column config and standalone mode must not leak into an embed.
reset_state();
\WapClient::register_chat_embed(embed_args([
    'column'      => ['side' => 'left', 'width' => '400px'],
    'render_mode' => 'standalone',
]));
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
$leaky = widget_config('content-ai');
// array_key_exists, not ?? — the expected value IS null, which ?? would mask.
check(
    'a stray column config cannot build panel chrome in an embed',
    array_key_exists('column', $leaky) && null === $leaky['column']
);
check('an embed cannot be forced into standalone mode', !isset($GLOBALS['wap_styles']['wap-client-standalone-content-ai']));

// -----------------------------------------------------------------------------
// Gating
// -----------------------------------------------------------------------------

echo "\nGating\n";

reset_state();
\WapClient::register_chat_embed(embed_args());
do_action('admin_enqueue_scripts', 'options-general.php');
check('a screen that was not opted in loads nothing', !isset($GLOBALS['wap_scripts']['wap-client-chat-content-ai']));
check('a screen that was not opted in renders nothing', '' === \WapClient::get_chatbox('content-ai'));
check('has_chatbox() is false there', !\WapClient::has_chatbox('content-ai'));

reset_state();
\WapClient::register_chat_embed(embed_args());
do_action('admin_enqueue_scripts', 'rank-math_page_rank-math-content-ai');
$GLOBALS['wap_can'] = false;
check('the capability is re-checked at render time', '' === \WapClient::get_chatbox('content-ai'));
check('has_chatbox() honours the capability', !\WapClient::has_chatbox('content-ai'));

// Calling the render helpers for an id nobody registered must be inert, since
// the documented contract is that a host may call them unconditionally.
reset_state();
check('get_chatbox() is empty for an unknown id', '' === \WapClient::get_chatbox('never-registered'));
check('has_chatbox() is false for an unknown id', !\WapClient::has_chatbox('never-registered'));
ob_start();
\WapClient::render_chatbox('never-registered');
check('render_chatbox() is silent for an unknown id', '' === trim((string) ob_get_clean()));

// -----------------------------------------------------------------------------

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
