<?php
/**
 * Test helper: load a class file from includes/ a second time under another namespace.
 *
 * Not named test-*.php, so scripts/run-php-tests.sh does not run it as a test.
 *
 * @package GroupOne\WapClient\Tests
 */

/**
 * Evaluate includes/$file with its namespace swapped, like a namespace-prefixed bundle.
 *
 * The declare(strict_types=1); line is removed because eval()'d code cannot start with it, so the
 * copy runs in weak mode. Exits non-zero with a message when a replacement matches nothing.
 *
 * @param string $file    Class file name inside includes/, e.g. 'class-config.php'.
 * @param string $from_ns Namespace declared by the file, e.g. 'GroupOne\WapClient'.
 * @param string $to_ns   Namespace to evaluate it under.
 */
function eval_prefixed_copy(string $file, string $from_ns, string $to_ns): void
{
    $path = __DIR__ . '/../includes/' . $file;
    $src  = (string) file_get_contents($path);

    $had_strict = false !== strpos($src, 'declare(strict_types=1);');
    $src        = preg_replace('/^declare\(strict_types=1\);\R/m', '', $src, 1, $stripped);
    if ($had_strict && 1 !== $stripped) {
        fwrite(STDERR, "prefixed-copy.php: could not remove declare(strict_types=1); from includes/{$file}; fix the pattern in tests/prefixed-copy.php\n");
        exit(1);
    }

    $src = str_replace('namespace ' . $from_ns . ';', 'namespace ' . $to_ns . ';', $src, $swapped);
    if (1 !== $swapped) {
        fwrite(STDERR, "prefixed-copy.php: 'namespace {$from_ns};' not found exactly once in includes/{$file}; fix the call or the file\n");
        exit(1);
    }

    eval('?>' . $src);
}
