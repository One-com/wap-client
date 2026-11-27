#!/bin/sh
# Runs every tests/test-*.php with php, keeps going after a failure and exits non-zero if any failed.
# Usage: scripts/run-php-tests.sh   (from anywhere; PHP_BIN overrides the php binary)
set -u

cd "$(dirname "$0")/.." || exit 1
PHP_BIN=${PHP_BIN:-php}

"$PHP_BIN" -v | head -n 1

total=0
failed=0
for f in tests/test-*.php; do
    [ -e "$f" ] || { echo "No tests/test-*.php found in $(pwd)" >&2; exit 1; }
    total=$((total + 1))
    echo "== $f"
    if ! "$PHP_BIN" "$f"; then
        failed=$((failed + 1))
        echo "FAILED: $f"
    fi
done

echo
echo "$((total - failed))/$total test scripts passed"
[ "$failed" -eq 0 ]
