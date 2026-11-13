<?php
/**
 * Standalone test: Config holds per-copy settings, not process-wide constants.
 *
 * Run directly: php tests/test-config.php
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

define('ABSPATH', '/tmp/wp/');

function plugin_dir_url(string $file): string
{
    return 'https://site.test/wp-content/plugins/' . basename(dirname($file)) . '/';
}

require_once __DIR__ . '/../includes/class-config.php';

use GroupOne\WapClient\Config;

$failures = 0;
function check(string $name, bool $ok): void
{
    global $failures;
    echo ($ok ? '  ok  ' : 'FAIL  ') . $name . "\n";
    $failures += $ok ? 0 : 1;
}

check('version defaults to the class constant', Config::version() === Config::VERSION);
check('url defaults to the package root', 'https://site.test/wp-content/plugins/' . basename(dirname(__DIR__)) . '/' === Config::url());
check('file defaults to the package main file', dirname(__DIR__) . '/wap-client.php' === Config::file());

Config::configure(['url' => 'https://site.test/x/deps', 'version' => '9.9.9', 'file' => '/p/deps/wap-client.php']);
check('configure() sets the url with a trailing slash', 'https://site.test/x/deps/' === Config::url());
check('configure() sets the version', '9.9.9' === Config::version());
check('configure() sets the file', '/p/deps/wap-client.php' === Config::file());

// Two copies under different prefixes keep separate settings: simulate the prefixed copy by evaluating the
// same class under another namespace.
$copy = str_replace('namespace GroupOne\WapClient;', 'namespace Other\Prefix\WapClient;', (string) file_get_contents(__DIR__ . '/../includes/class-config.php'));
eval('?>' . $copy);
check('a second copy does not see the first copy\'s settings', 'https://site.test/x/deps/' !== \Other\Prefix\WapClient\Config::url());
check('and keeps its own version', \Other\Prefix\WapClient\Config::VERSION === \Other\Prefix\WapClient\Config::version());

Config::reset();
check('reset() restores the defaults', Config::version() === Config::VERSION);

echo $failures ? "\n{$failures} failed.\n" : "\nAll tests passed.\n";
exit($failures ? 1 : 0);
