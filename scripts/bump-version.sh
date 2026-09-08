#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 X.Y.Z[-prerelease]" >&2
  echo "Example: $0 2.2.1" >&2
  echo "Example: $0 2.2.1-beta.1" >&2
  exit 1
fi

VERSION="$1"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "ERROR: '$VERSION' is not a valid X.Y.Z[-prerelease] version" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

COMPOSER_JSON="$DIR/composer.json"
PACKAGE_JSON="$DIR/package.json"
PLUGIN_PHP="$DIR/wap-client.php"

for f in "$COMPOSER_JSON" "$PACKAGE_JSON" "$PLUGIN_PHP"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing file: $f" >&2
    exit 1
  fi
done

extract_json_version() {
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$1" | head -1
}

extract_php_version() {
  sed -nE 's/.*\* Version:[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?).*/\1/p' "$1" | head -1
}

PREV_COMPOSER="$(extract_json_version "$COMPOSER_JSON")"
PREV_NPM="$(extract_json_version "$PACKAGE_JSON")"
PREV_PHP="$(extract_php_version "$PLUGIN_PHP")"

for label in "composer.json:$PREV_COMPOSER" "package.json:$PREV_NPM" "wap-client.php:$PREV_PHP"; do
  name="${label%%:*}"
  val="${label#*:}"
  if [ -z "$val" ]; then
    echo "ERROR: could not read version from $name" >&2
    exit 1
  fi
done

if [ "$PREV_COMPOSER" != "$PREV_NPM" ] || [ "$PREV_COMPOSER" != "$PREV_PHP" ]; then
  echo "ERROR: existing versions are out of sync before the bump:" >&2
  echo "  composer.json : $PREV_COMPOSER" >&2
  echo "  package.json  : $PREV_NPM" >&2
  echo "  wap-client.php: $PREV_PHP" >&2
  echo "Resolve the divergence manually before running this script." >&2
  exit 1
fi

sed -i.bak -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+(\")/\1${VERSION}\2/" \
  "$COMPOSER_JSON" "$PACKAGE_JSON"

sed -i.bak -E "s|(^[[:space:]]*\*[[:space:]]Version:[[:space:]]+)[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?|\1${VERSION}|" \
  "$PLUGIN_PHP"

rm -f "$COMPOSER_JSON.bak" "$PACKAGE_JSON.bak" "$PLUGIN_PHP.bak"

POST_COMPOSER="$(extract_json_version "$COMPOSER_JSON")"
POST_NPM="$(extract_json_version "$PACKAGE_JSON")"
POST_PHP="$(extract_php_version "$PLUGIN_PHP")"

if [ "$POST_COMPOSER" != "$VERSION" ] || [ "$POST_NPM" != "$VERSION" ] || [ "$POST_PHP" != "$VERSION" ]; then
  echo "ERROR: post-bump verification failed:" >&2
  echo "  expected       : $VERSION" >&2
  echo "  composer.json  : $POST_COMPOSER" >&2
  echo "  package.json   : $POST_NPM" >&2
  echo "  wap-client.php : $POST_PHP" >&2
  exit 1
fi

echo "Bumped wap-client $PREV_COMPOSER → $VERSION"
echo "  composer.json : $POST_COMPOSER"
echo "  package.json  : $POST_NPM"
echo "  wap-client.php: $POST_PHP"
echo ""
echo "Next steps:"
echo "  git add $COMPOSER_JSON $PACKAGE_JSON $PLUGIN_PHP"
echo "  git commit -m \"chore: bump wap-client to $VERSION\""
