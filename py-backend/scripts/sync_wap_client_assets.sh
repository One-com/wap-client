#!/usr/bin/env bash
#
# Sync the WordPress client chat assets into the backend's static dir.
#
# The WP plugin (wp-client-plugin/wap-client/assets/) is the single canonical
# source for wap-chat.js / wap-chat.css. The backend is built and deployed as a
# standalone image that does NOT contain the wp-client-plugin directory, so the
# admin chat tester needs its own committed copy of these files.
#
# This sync is intentionally MANUAL / on-demand — it is not wired into the build
# or CI. After editing the WP client JS/CSS, run this script and commit the
# refreshed copies.
#
# Usage:
#   scripts/sync_wap_client_assets.sh          Copy assets into app/static/admin/
#   scripts/sync_wap_client_assets.sh --check  Exit non-zero if the copies drift
#
set -euo pipefail

# Repo root = two levels up from this script (py-backend/scripts/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SRC_DIR="${REPO_ROOT}/wp-client-plugin/wap-client/assets"
DEST_DIR="${REPO_ROOT}/py-backend/app/static/admin"

FILES=(wap-chat.js wap-chat.css)

if [[ ! -d "${SRC_DIR}" ]]; then
    echo "error: source dir not found: ${SRC_DIR}" >&2
    exit 1
fi

mkdir -p "${DEST_DIR}"

if [[ "${1:-}" == "--check" ]]; then
    drift=0
    for f in "${FILES[@]}"; do
        if ! diff -q "${SRC_DIR}/${f}" "${DEST_DIR}/${f}" >/dev/null 2>&1; then
            echo "DRIFT: ${f} differs (or is missing) between WP plugin and backend copy" >&2
            drift=1
        fi
    done
    if [[ "${drift}" -ne 0 ]]; then
        echo "Run scripts/sync_wap_client_assets.sh and commit the result." >&2
        exit 1
    fi
    echo "OK: backend asset copies are in sync with the WP plugin."
    exit 0
fi

for f in "${FILES[@]}"; do
    cp "${SRC_DIR}/${f}" "${DEST_DIR}/${f}"
    echo "synced ${f} -> py-backend/app/static/admin/${f}"
done
