#!/usr/bin/env bash
#
# Asserts that the archive Composer serves to consumers is exactly the set of
# production files — nothing dev-only leaked in, nothing runtime got dropped.
#
# It reproduces what a consumer actually downloads: GitHub builds the zipball
# for groupone/wap-client with `git archive`, which applies the export-ignore
# rules in .gitattributes. Running the same command here catches a regression
# in CI instead of in someone's vendor/ directory.
#
# The check is derived, not hardcoded: every tracked file is classified as SHIP
# or DEV by the patterns below, and the archive must equal the SHIP set. A path
# matching neither is a hard failure, so a new directory cannot slip through
# unnoticed — it has to be classified first.
#
# Usage: scripts/check-dist-contents.sh [git-ref]      (default: HEAD)

set -euo pipefail

REF="${1:-HEAD}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Must NOT ship. Patterns are root-anchored and matched with `case`, so a
# trailing /* covers a whole directory tree.
DEV_PATTERNS=(
  "tests/*"
  "npm/*"
  "scripts/*"
  "package.json"
  "i18n/*.po"
  "i18n/*.pot"
  ".gitattributes"
  ".gitignore"
  ".npmrc"
  "dist/*"
  "node_modules/*"
  "vendor/*"
  "src/dev/*"
  "*.tgz"
)

# Must ship: the library, the runtime assets (assets/vendor/ carries the
# vendored Mixpanel SDK and the Apache-2.0 notice that has to travel with it),
# the compiled translations, the manifest and the plugin header.
SHIP_PATTERNS=(
  "includes/*.php"
  "assets/*"
  "i18n/*.mo"
  "composer.json"
  "wap-client.php"
  "README.md"
)

# A floor under the derived check: these are load-bearing at runtime, so if one
# ever disappeared from the tree entirely, SHIP and the archive would still
# agree with each other and the derived check alone would stay green.
CORE=(
  "composer.json"
  "wap-client.php"
  "includes/class-chat-widget.php"
  "includes/class-token-manager.php"
  "includes/class-grnd-provider.php"
  "assets/wap-chat.js"
  "assets/wap-chat.css"
  "assets/wap-standalone.css"
  "assets/vendor/mixpanel.min.js"
  "assets/vendor/mixpanel-loader.js"
  "assets/vendor/README.md"
)

matches_any() {
  local path="$1"
  shift
  local pattern
  for pattern in "$@"; do
    # shellcheck disable=SC2254  # the patterns are intentionally globs
    case "$path" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

# `<ref>:` resolves relative to the current directory, so both git commands act
# on the package subtree exactly as the mirror publishes it.
TARBALL="$(mktemp -t wap-client-dist.XXXXXX)"
trap 'rm -f "$TARBALL"' EXIT

if ! git archive "${REF}:" --format=tar > "$TARBALL" 2>/dev/null; then
  echo "ERROR: 'git archive ${REF}:' failed — wrong ref, or not run inside the package?" >&2
  exit 1
fi

SHIPPED="$(tar -tf "$TARBALL" | grep -v '/$' | sort)"
TRACKED="$(git ls-tree -r --name-only "${REF}:" | sort)"

if [ -z "$SHIPPED" ] || [ -z "$TRACKED" ]; then
  echo "ERROR: no files found at ${REF} — wrong ref, or not run inside the package?" >&2
  exit 1
fi

FAILED=0
EXPECTED=""
UNCLASSIFIED=""

while IFS= read -r path; do
  if matches_any "$path" "${DEV_PATTERNS[@]}"; then
    continue
  elif matches_any "$path" "${SHIP_PATTERNS[@]}"; then
    EXPECTED="${EXPECTED}${path}"$'\n'
  else
    UNCLASSIFIED="${UNCLASSIFIED}${path}"$'\n'
  fi
done <<< "$TRACKED"

if [ -n "$UNCLASSIFIED" ]; then
  echo "FAIL: path(s) classified as neither production nor development:" >&2
  printf '%s' "$UNCLASSIFIED" | sed 's/^/        /' >&2
  echo "        Decide which they are: add them to .gitattributes + DEV_PATTERNS," >&2
  echo "        or to SHIP_PATTERNS if they belong in the published package." >&2
  FAILED=1
fi

EXPECTED="$(printf '%s' "$EXPECTED" | sort)"

leaked="$(comm -23 <(printf '%s\n' "$SHIPPED") <(printf '%s\n' "$EXPECTED") || true)"
if [ -n "$leaked" ]; then
  echo "FAIL: development-only file(s) present in the published archive:" >&2
  printf '%s\n' "$leaked" | sed 's/^/        /' >&2
  echo "        Add an export-ignore rule to .gitattributes." >&2
  FAILED=1
fi

dropped="$(comm -13 <(printf '%s\n' "$SHIPPED") <(printf '%s\n' "$EXPECTED") || true)"
if [ -n "$dropped" ]; then
  echo "FAIL: production file(s) missing from the published archive:" >&2
  printf '%s\n' "$dropped" | sed 's/^/        /' >&2
  echo "        An export-ignore rule in .gitattributes is too broad." >&2
  FAILED=1
fi

for path in "${CORE[@]}"; do
  if ! printf '%s\n' "$SHIPPED" | grep -qxF -- "$path"; then
    echo "FAIL: core runtime file missing from the published archive: $path" >&2
    FAILED=1
  fi
done

if ! printf '%s\n' "$SHIPPED" | grep -q '^i18n/.*\.mo$'; then
  echo "FAIL: no compiled .mo translations in the published archive" >&2
  FAILED=1
fi

COUNT="$(printf '%s\n' "$SHIPPED" | wc -l | tr -d ' ')"
KIB="$(( $(wc -c < "$TARBALL") / 1024 ))"

if [ "$FAILED" -ne 0 ]; then
  echo "" >&2
  echo "Archive as it stands (${COUNT} files, ${KIB} KiB):" >&2
  printf '%s\n' "$SHIPPED" | sed 's/^/  /' >&2
  exit 1
fi

echo "OK: published archive is exactly the production set — ${COUNT} files, ${KIB} KiB uncompressed."
printf '%s\n' "$SHIPPED" | sed 's/^/  /'
