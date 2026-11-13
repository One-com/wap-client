<?php
/**
 * Standalone test: wap-client.php must be safe to load outside WordPress.
 *
 * Composer autoloads it as a `files` entry, so a consumer's PHPUnit, PHPCS or PHPStan run
 * loads it with no ABSPATH. An `exit` there ended those runs with status 0 and no output.
 * Run directly: php tests/test-autoload-safety.php
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

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
 * Require wap-client.php in a fresh PHP process and report what happened.
 *
 * A subprocess is essential: if the file ever calls exit again, it must not take this
 * script down with it — a test that silently exits 0 would look like a pass.
 *
 * @return array{stdout: string, code: int}
 */
function load_in_subprocess(string $prelude): array
{
    $script = $prelude
        . 'require ' . var_export(dirname(__DIR__) . '/wap-client.php', true) . ';'
        . 'echo "STILL_RUNNING";';
    $out  = [];
    $code = 0;
    exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($script) . ' 2>&1', $out, $code);
    return ['stdout' => implode("\n", $out), 'code' => $code];
}

$result = load_in_subprocess('');
check('loading without ABSPATH does not end the calling process', false !== strpos($result['stdout'], 'STILL_RUNNING'));
check('loading without ABSPATH exits cleanly', 0 === $result['code']);
check('loading without ABSPATH touches no WordPress function', false === strpos($result['stdout'], 'undefined function'));

// PHP declares a file's top-level classes and functions at compile time, before any guard runs, so
// they must live in a file required past it. Otherwise a consumer's tests can't define their own fakes.
$result = (function (): array {
    $script = 'require ' . var_export(dirname(__DIR__) . '/wap-client.php', true) . ';'
        . 'echo json_encode([class_exists("WapClient", false), function_exists("wap_client_boot"),'
        . ' function_exists("wap_client_activate"), function_exists("wap_client_deactivate"),'
        . ' function_exists("wap_client_load_textdomain")]);';
    $out = [];
    exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($script) . ' 2>&1', $out);
    return (array) json_decode(implode('', $out), true);
})();
check('loading without ABSPATH declares no WapClient class', ($result[0] ?? true) === false);
check('loading without ABSPATH declares no wap_client_* function', array_slice($result, 1) === [false, false, false, false]);


// ---------------------------------------------------------------------------
// With WordPress present (ABSPATH and the few functions the entry file calls): the public global names exist,
// and loading the library twice — two bundled copies at different paths — must not fatally redeclare them.
// ---------------------------------------------------------------------------

$copy_dir = sys_get_temp_dir() . '/wap-client-copy-' . bin2hex(random_bytes(4));
mkdir($copy_dir . '/includes', 0777, true);
copy(dirname(__DIR__) . '/wap-client.php', $copy_dir . '/wap-client.php');
copy(dirname(__DIR__) . '/wap-client-api.php', $copy_dir . '/wap-client-api.php');
foreach ((array) glob(dirname(__DIR__) . '/includes/*.php') as $file) {
    copy($file, $copy_dir . '/includes/' . basename($file));
}

/**
 * Run a PHP snippet in a fresh process with a minimal WordPress shim; return the decoded JSON it echoes.
 *
 * @return array<string, mixed>|null Null when the process died or printed anything but one JSON object.
 */
function run_with_wordpress(string $body): ?array
{
    $shim = 'define("ABSPATH", "/wp/");'
        . 'function plugin_dir_path($f) { return dirname($f) . "/"; }'
        . 'function plugin_dir_url($f) { return "https://site.test/" . basename(dirname($f)) . "/"; }'
        . 'function register_activation_hook(...$a) { $GLOBALS["activation"][] = $a; }'
        . 'function register_deactivation_hook(...$a) {}'
        . 'function add_action($hook, $cb, $prio = 10) { $GLOBALS["hooks"][$hook][] = $prio; }';
    $out = [];
    exec(escapeshellarg(PHP_BINARY) . ' -d display_errors=1 -r ' . escapeshellarg($shim . $body) . ' 2>&1', $out);
    $decoded = json_decode(implode("\n", $out), true);

    return is_array($decoded) ? $decoded : null;
}

$first  = var_export(dirname(__DIR__) . '/wap-client.php', true);
$second = var_export($copy_dir . '/wap-client.php', true);

$single = run_with_wordpress(
    'require ' . $first . ';'
    . 'echo json_encode(['
    . '"class" => class_exists("WapClient", false),'
    . '"alias" => (new ReflectionClass("WapClient"))->getName() === "GroupOne\\\\WapClient\\\\WapClient",'
    . '"functions" => array_map("function_exists", ["wap_client_activate", "wap_client_deactivate", "wap_client_load_textdomain", "wap_client_boot"]),'
    . '"constants" => array_map("defined", ["WAP_CLIENT_VERSION", "WAP_CLIENT_FILE", "WAP_CLIENT_DIR", "WAP_CLIENT_URL"]),'
    . '"version" => WAP_CLIENT_VERSION === GroupOne\WapClient\Config::VERSION,'
    . '"hooks" => ["init" => $GLOBALS["hooks"]["init"] ?? null, "plugins_loaded" => $GLOBALS["hooks"]["plugins_loaded"] ?? null],'
    . ']);'
);
check('with WordPress, loading wap-client.php succeeds', null !== $single);
check('the global WapClient class exists and is an alias of the namespaced facade', true === ($single['class'] ?? false) && true === ($single['alias'] ?? false));
check('the four wap_client_* functions exist', [true, true, true, true] === ($single['functions'] ?? []));
check('the four WAP_CLIENT_* constants exist', [true, true, true, true] === ($single['constants'] ?? []));
check('WAP_CLIENT_VERSION mirrors Config::VERSION', true === ($single['version'] ?? false));
check('init and plugins_loaded are hooked once each', [10] === ($single['hooks']['init'] ?? null) && [20] === ($single['hooks']['plugins_loaded'] ?? null));

$double = run_with_wordpress(
    'require ' . $first . ';'
    . 'require ' . $second . ';'
    . 'echo json_encode(["loaded" => true, "file" => WAP_CLIENT_FILE, "hooks" => $GLOBALS["hooks"]["plugins_loaded"] ?? null]);'
);
check('loading a second copy of the library does not fatally redeclare anything', true === ($double['loaded'] ?? false));
check('the first copy wins the constants', ($double['file'] ?? '') === dirname(__DIR__) . '/wap-client.php');
check('and the boot hook is registered once, not twice', [20] === ($double['hooks'] ?? null));

$reversed = run_with_wordpress('require ' . $second . ';' . 'require ' . $first . ';' . 'echo json_encode(["loaded" => true]);');
check('either load order works', true === ($reversed['loaded'] ?? false));

foreach ((array) glob($copy_dir . '/includes/*.php') as $file) {
    unlink($file);
}
@unlink($copy_dir . '/wap-client.php');
@unlink($copy_dir . '/wap-client-api.php');
@rmdir($copy_dir . '/includes');
@rmdir($copy_dir);

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
