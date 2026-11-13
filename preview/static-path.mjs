/**
 * Which file a request path under a static prefix names. Pure, so
 * npm/test-widget.mjs covers it; server.mjs reads and sends the file.
 */

import { join, normalize, sep } from 'node:path';

/**
 * @param {string} pathname the request path, e.g. "/assets/wap-chat.css"
 * @param {Record<string, string>} folders URL prefix to the folder it serves
 * @returns {{file: string}|{status: number}|null} null when no prefix matches
 */
export function resolveStatic(pathname, folders) {
    const prefix = Object.keys(folders).find((p) => pathname.startsWith(p));
    if (!prefix) return null;
    const base = folders[prefix];
    let requested;
    try {
        requested = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
        return { status: 400 };
    }
    const file = normalize(join(base, requested));
    return file.startsWith(base + sep) ? { file } : { status: 403 };
}
