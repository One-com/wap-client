/**
 * @group-one/wap-client/server — Node server SDK for SaaS hosts.
 *
 * The brand backend has exactly ONE job in the WAP flow: issue a GRND for the
 * logged-in user and hand it to the browser. The widget then sends that GRND
 * directly to WAP as the Bearer credential on every call — there is NO
 * connection between the brand backend and WAP at all.
 *
 *   browser widget ──getSession()──▶ YOUR endpoint (this SDK) ──▶ your issuer
 *   browser widget ──Bearer GRND──▶ WAP (chat / history / GDPR)
 *
 * This SDK implements that job with the same guarantees as the PHP library
 * (docs/wap-backend-grnd-requirements.md §8), so no brand hand-rolls it:
 *   - GRND sanity check before caching or handing out: 3-part JWT, alg EdDSA,
 *     jti matching grn:2@int:grnd:<realm>:wap/<nonce> (≤256 chars), positive exp
 *   - per-user cache with TTL = min(jwt exp, issuer expires_at) − 60s slack
 *   - forceNew (the widget's retry-after-401 flag) drops the cache and
 *     re-issues, so an expired/revoked GRND heals in one round trip
 *
 * Because the GRND is held by the browser, issue SHORT-LIVED GRNDs (minutes
 * to hours, not the 32-day spec maximum) — the TokenManager cache makes
 * frequent re-issuance cheap for your issuer.
 *
 * Zero dependencies — Node ≥ 18 (node:crypto). If your GRNDs embed a sealed
 * platform credential, produce it inside your provider (libsodium-wrappers
 * offers crypto_box_seal, compatible with the PHP TokenSealer); it stays
 * opaque to the browser — sealed to WAP's wrap key.
 */

if (typeof window !== 'undefined') {
    throw new Error('@group-one/wap-client/server is server-only code and must never be bundled for the browser.');
}

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants — keep in lockstep with includes/class-token-manager.php
// ---------------------------------------------------------------------------

const EXPIRY_SLACK_SECONDS = 60;
const REQUIRED_ALG = 'EdDSA';
const JTI_PATTERN = /^grn:2@int:grnd:[a-z0-9._-]*:wap\/.+$/;
const GRN_MAX_LENGTH = 256;

// ---------------------------------------------------------------------------
// WapError — every failure carries a machine-readable code (same codes as the
// PHP WP_Error codes). Hosts must map ALL of these to a generic user-facing
// message; log code + status server-side for diagnostics.
// ---------------------------------------------------------------------------

export class WapError extends Error {
    /**
     * @param {string} code    Machine-readable code, e.g. 'wap_grnd_unavailable'.
     * @param {string} message Diagnostic message — for logs, NOT for end users.
     * @param {number} [status] Upstream HTTP status, when applicable.
     */
    constructor(code, message, status) {
        super(message);
        this.name = 'WapError';
        this.code = code;
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// GRND sanity check — structural pre-flight, NOT cryptographic verification
// (signature verification is WAP's job; the brand backend just refuses to
// cache or hand out obviously broken tokens). Port of
// TokenManager::sanity_check().
// ---------------------------------------------------------------------------

function b64urlJson(part) {
    try {
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Validate GRND structure. Returns the decoded payload on success.
 *
 * @param {string} grnd Compact JWT string.
 * @returns {{exp: number, jti: string, [k: string]: unknown}}
 * @throws {WapError} wap_grnd_malformed | wap_grnd_bad_alg | wap_grnd_bad_jti | wap_grnd_missing_exp
 */
export function sanityCheckGrnd(grnd) {
    if (typeof grnd !== 'string' || grnd.split('.').length !== 3) {
        throw new WapError('wap_grnd_malformed', 'GRND is not a three-part compact JWT.');
    }
    const [rawHeader, rawPayload] = grnd.split('.');
    const header = b64urlJson(rawHeader);
    const payload = b64urlJson(rawPayload);
    if (!header || !payload) {
        throw new WapError('wap_grnd_malformed', 'GRND header or payload is not valid base64url JSON.');
    }
    if (header.alg !== REQUIRED_ALG) {
        throw new WapError('wap_grnd_bad_alg', `GRND alg must be ${REQUIRED_ALG}, got ${String(header.alg)}.`);
    }
    // Require the standard JWT `typ` header — mirrors the PHP sanity check.
    if (header.typ !== 'JWT') {
        throw new WapError('wap_grnd_malformed', `GRND typ must be JWT, got ${String(header.typ)}.`);
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : '';
    if (!jti || jti.length > GRN_MAX_LENGTH || !JTI_PATTERN.test(jti)) {
        throw new WapError('wap_grnd_bad_jti', 'GRND jti is not a valid GRN designation for wap.');
    }
    if (typeof payload.exp !== 'number' || payload.exp <= 0) {
        throw new WapError('wap_grnd_missing_exp', 'GRND payload has no positive exp claim.');
    }
    return payload;
}

// ---------------------------------------------------------------------------
// Storage — pluggable cache. Default is in-memory (fine for a single
// process; supply a Redis-backed implementation in multi-instance deploys).
// Contract: get(key) → string|null|undefined, set(key, value, ttlSeconds),
// delete(key). All may be async.
// ---------------------------------------------------------------------------

export class MemoryStorage {
    constructor() {
        this._map = new Map();
    }

    get(key) {
        const hit = this._map.get(key);
        if (!hit) return null;
        if (hit.expiresAt <= Date.now()) {
            this._map.delete(key);
            return null;
        }
        return hit.value;
    }

    set(key, value, ttlSeconds) {
        this._map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    }

    delete(key) {
        this._map.delete(key);
    }
}

// ---------------------------------------------------------------------------
// TokenManager — GRND acquisition + caching. Port of class-token-manager.php.
// This IS the session endpoint's implementation: wire get() to the route
// behind your login and return {token} to the browser widget.
//
//   const tokens = new TokenManager({ provider: issueGrndForUser });
//   app.post('/api/wap/session', requireLogin, async (req, res) => {
//       const token = await tokens.get({
//           cacheKey: String(req.user.id),
//           forceNew: !!req.body.forceNew,   // widget's retry-after-401 flag
//       });
//       res.json({ token });                 // token IS the GRND
//   });
// ---------------------------------------------------------------------------

export class TokenManager {
    /**
     * @param {object} opts
     * @param {(ctx: {cacheKey: string, forceNew: boolean}) => Promise<{grnd: string, expires_at?: number}|string>} opts.provider
     *   Brand-specific GRND source — the ONLY thing that differs per brand.
     *   partners.one: call your own issuer for the logged-in user. Licensed
     *   products: POST {license_key, product, site_url, ...} to the brand
     *   issuer (see createIssuerProvider). May return the JWT string directly
     *   or {grnd, expires_at} where expires_at is a unix-seconds cap from the
     *   issuer response.
     * @param {object} [opts.storage]   Cache implementing get/set/delete. Defaults to in-process MemoryStorage.
     * @param {string} [opts.keyPrefix] Cache key namespace. Default 'wap_grnd'.
     *   GRNDs are product-scoped: use ONE TokenManager per product (give each
     *   its own keyPrefix, e.g. 'wap_grnd:partners-one'), or include the
     *   product in every cacheKey — otherwise a multi-product host would
     *   serve one product's GRND for another. (The PHP TokenManager keys by
     *   user AND product for the same reason.)
     */
    constructor({ provider, storage, keyPrefix = 'wap_grnd' } = {}) {
        if (typeof provider !== 'function') {
            throw new TypeError('TokenManager requires a provider function.');
        }
        this._provider = provider;
        this._storage = storage || new MemoryStorage();
        this._keyPrefix = keyPrefix;
    }

    _storageKey(cacheKey) {
        return this._keyPrefix + ':' + createHash('sha256').update(String(cacheKey)).digest('hex');
    }

    /**
     * Return a sane GRND for cacheKey (typically your user id), from cache or
     * freshly acquired. Only tokens that pass the sanity check are cached.
     *
     * @param {{cacheKey?: string, forceNew?: boolean}} [opts]
     * @returns {Promise<string>}
     */
    async get({ cacheKey = 'default', forceNew = false } = {}) {
        const key = this._storageKey(cacheKey);

        if (forceNew) {
            await this._storage.delete(key);
        } else {
            const cached = await this._storage.get(key);
            if (typeof cached === 'string' && cached) {
                try {
                    sanityCheckGrnd(cached);
                    return cached;
                } catch {
                    await this._storage.delete(key); // defensively drop corrupt cache entries
                }
            }
        }

        const result = await this._provider({ cacheKey, forceNew });
        const grnd = typeof result === 'string' ? result : result && result.grnd;
        const issuerExpiresAt = typeof result === 'object' && result && typeof result.expires_at === 'number'
            ? result.expires_at
            : 0;

        if (typeof grnd !== 'string' || !grnd) {
            throw new WapError('wap_grnd_unavailable', 'GRND provider returned no token.');
        }
        const payload = sanityCheckGrnd(grnd);

        // TTL = min(jwt exp, issuer expires_at) − slack. An already-expired
        // token is unusable — fail here rather than in the browser.
        const nowSeconds = Math.floor(Date.now() / 1000);
        const hardExpiry = issuerExpiresAt > 0 ? Math.min(payload.exp, issuerExpiresAt) : payload.exp;
        const ttl = hardExpiry - nowSeconds - EXPIRY_SLACK_SECONDS;
        if (hardExpiry <= nowSeconds) {
            throw new WapError('wap_grnd_expired', 'GRND provider returned an already-expired token.');
        }
        if (ttl > 0) {
            await this._storage.set(key, grnd, ttl);
        }
        return grnd;
    }

    /**
     * Drop the cached GRND (call when the user's entitlement changes, on
     * logout, or when the underlying credential rotates — the PHP library
     * does this on App Password rotation).
     */
    async forget(cacheKey = 'default') {
        await this._storage.delete(this._storageKey(cacheKey));
    }
}

// ---------------------------------------------------------------------------
// createIssuerProvider — provider for brands with the standardized issuer
// endpoint (same contract as PHP LicenseGrndProvider). Brands with a custom
// backend just write their own provider function instead.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.issuerUrl   Brand GRND issuer endpoint.
 * @param {string} [opts.licenseKey] License key when the brand licenses per site/customer.
 * @param {string} opts.product     Product slug.
 * @param {string} opts.siteUrl     Public URL of the embedding site/app.
 * @param {(ctx: {cacheKey: string, forceNew: boolean}) => Promise<object>} [opts.credentials]
 *   Optional factory for extra issuance payload fields, invoked only on cache
 *   miss (lazy, like the PHP credentials factory that mints + seals the App
 *   Password). E.g. () => ({wrapped_app_token, wrap_key_id}).
 * @param {typeof fetch} [opts.fetchImpl] Injectable for tests.
 * @returns {(ctx: {cacheKey: string, forceNew: boolean}) => Promise<{grnd: string, expires_at?: number}>}
 */
export function createIssuerProvider({ issuerUrl, licenseKey, product, siteUrl, credentials, fetchImpl } = {}) {
    if (!issuerUrl || !product || !siteUrl) {
        throw new TypeError('createIssuerProvider requires issuerUrl, product and siteUrl.');
    }
    const doFetch = fetchImpl || fetch;

    return async function issuerProvider(ctx) {
        const payload = {
            product,
            site_url: siteUrl,
            ...(licenseKey ? { license_key: licenseKey } : {}),
            ...(credentials ? await credentials(ctx) : {}),
        };

        const res = await doFetch(issuerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (res.status === 401 || res.status === 403) {
            throw new WapError('wap_grnd_not_entitled', 'Brand issuer rejected the entitlement.', res.status);
        }
        if (!res.ok) {
            throw new WapError('wap_grnd_unavailable', `Brand issuer request failed (HTTP ${res.status}).`, res.status);
        }

        const body = await res.json().catch(() => null);
        if (!body || typeof body.grnd !== 'string') {
            throw new WapError('wap_grnd_unavailable', 'Brand issuer response has no grnd field.');
        }
        return { grnd: body.grnd, expires_at: typeof body.expires_at === 'number' ? body.expires_at : 0 };
    };
}

// ---------------------------------------------------------------------------
// WapGrndClient — the facade. One object, one method: getGrnd(). Wires the
// TokenManager and (when the brand uses the standardized issuer endpoint)
// createIssuerProvider together, and namespaces the cache by product so two
// products can never serve each other's GRNDs. Most integrations need
// nothing else:
//
//   const wap = new WapGrndClient({
//       product: 'partners-one',
//       provider: async ({ cacheKey }) => issueGrndForUser(cacheKey),
//   });
//   app.post('/api/wap/session', requireLogin, async (req, res) => {
//       res.json({ token: await wap.getGrnd({
//           userKey: String(req.user.id),
//           forceNew: !!req.body.forceNew,
//       }) });
//   });
// ---------------------------------------------------------------------------

export class WapGrndClient {
    /**
     * @param {object} opts
     * @param {string} opts.product    Product slug registered with WAP. Also
     *   namespaces the GRND cache — one client per product.
     * @param {Function} [opts.provider] Your GRND source (see TokenManager).
     *   When omitted, the standardized issuer exchange is used and issuerUrl +
     *   siteUrl become required.
     * @param {string} [opts.issuerUrl]  Brand issuer endpoint (standardized contract).
     * @param {string} [opts.siteUrl]    Public URL of the embedding site/app.
     * @param {string} [opts.licenseKey] License key, when the brand licenses per site/customer.
     * @param {Function} [opts.credentials] Extra issuance payload factory (lazy; e.g. sealed credential fields).
     * @param {object} [opts.storage]    Cache implementing get/set/delete (Redis in multi-instance deploys).
     * @param {typeof fetch} [opts.fetchImpl] Injectable for tests.
     */
    constructor({ product, provider, issuerUrl, siteUrl, licenseKey, credentials, storage, fetchImpl } = {}) {
        if (!product) {
            throw new TypeError('WapGrndClient requires a product slug.');
        }
        const resolved = typeof provider === 'function'
            ? provider
            : createIssuerProvider({ issuerUrl, licenseKey, product, siteUrl, credentials, fetchImpl });
        this._tokens = new TokenManager({
            provider: resolved,
            storage,
            keyPrefix: 'wap_grnd:' + product,
        });
    }

    /**
     * Return a validated, cached GRND for one of your users — the exact value
     * your session endpoint hands to the widget as {token}. Pass the widget's
     * forceNew flag through so a WAP 401 heals in one round trip.
     *
     * @param {{userKey?: string, forceNew?: boolean}} [opts]
     * @returns {Promise<string>}
     */
    getGrnd({ userKey = 'default', forceNew = false } = {}) {
        return this._tokens.get({ cacheKey: userKey, forceNew });
    }

    /** Drop a user's cached GRND (logout, entitlement change). */
    forget(userKey = 'default') {
        return this._tokens.forget(userKey);
    }
}
