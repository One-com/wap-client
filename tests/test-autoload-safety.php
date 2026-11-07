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

echo $failures === 0 ? "\nAll tests passed.\n" : "\n{$failures} test(s) FAILED.\n";
exit($failures === 0 ? 0 : 1);
